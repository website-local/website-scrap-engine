import {recordResourcePublication, currentCrawlContext} from './crawl-context.js';
import {promises as fs, constants, lstat as lstatCallback} from 'node:fs';
import {promisify} from 'node:util';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

const lstat = promisify(lstatCallback);

// Windows needs the explicit destination check. On supported platforms, the
// kernel can reject symlinks atomically with opening the output file.
export const noFollowWriteFlags = process.platform !== 'win32' && constants.O_NOFOLLOW ?
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW : undefined;

async function checkDirectories(root: string, parent: string, create: boolean): Promise<void> {
  // root is canonical. If resolving the entire parent path leaves it unchanged,
  // none of its components redirects through a symlink. One native resolution
  // avoids a separate asynchronous lstat round trip for every existing level.
  try {
    const canonicalParent = await fs.realpath(parent);
    const samePath = process.platform === 'win32' ?
      canonicalParent.toLowerCase() === parent.toLowerCase() : canonicalParent === parent;
    if (!samePath) throw new Error('Output directory must not be a symlink: ' + parent);
    return;
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let current = root;
  for (const part of ['', ...relative(root, parent).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (!create || !part || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await fs.mkdir(current); } catch (error) {
        // Another publication may have created this directory concurrently.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Output directory must not be a symlink: ' + current);
    }
  }
}

async function resolveRoot(root: string): Promise<string> {
  try { return await fs.realpath(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.mkdir(root, {recursive: true});
    return fs.realpath(root);
  }
}

/** Prepare each directory once per crawl; publication still checks the live parent. */
export class OutputDirectories {
  private readonly roots = new Map<string, Promise<string>>();
  private readonly parents = new Map<string, Promise<void>>();

  root(root: string): Promise<string> {
    let pending = this.roots.get(root);
    if (!pending) {
      pending = resolveRoot(root).catch(error => { this.roots.delete(root); throw error; });
      this.roots.set(root, pending);
    }
    return pending;
  }

  prepare(root: string, parent: string): Promise<void> {
    let pending = this.parents.get(parent);
    if (!pending) {
      pending = checkDirectories(root, parent, true).catch(error => {
        this.parents.delete(parent);
        throw error;
      });
      this.parents.set(parent, pending);
    }
    return pending;
  }
}

/** Share a private directory only while publications in the same parent overlap. */
export class StagingDirectories {
  private readonly active = new Map<string, {directory: Promise<string>; references: number; next: number}>();

  async acquire(parent: string): Promise<{path: string; cleanup(published: boolean): Promise<void>}> {
    let entry = this.active.get(parent);
    if (!entry) {
      entry = {directory: fs.mkdtemp(join(parent, '.wse-stage-')), references: 0, next: 0};
      this.active.set(parent, entry);
    }
    ++entry.references;
    const id = ++entry.next;
    let directory: string;
    try { directory = await entry.directory; }
    catch (error) {
      if (--entry.references === 0) this.active.delete(parent);
      throw error;
    }
    const path = join(directory, String(id));
    const lease = entry;
    return {path, cleanup: async published => {
      try {
        if (!published) await fs.rm(path, {recursive: true, force: true});
      } finally {
        if (--lease.references === 0) {
          // New publications must allocate a different directory while this one closes.
          this.active.delete(parent);
          try { await fs.rmdir(directory); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              await fs.rm(directory, {recursive: true, force: true});
            }
          }
        }
      }
    }};
  }
}

/** An output allocation whose publication and cleanup can be owned by another service. */
export interface FilePublication {
  /** Writer target: the destination in direct mode, a temporary path in atomic mode. */
  readonly stagingPath: string;
  readonly direct?: boolean;
  /** Starts at most once; repeated calls share the same operation. */
  publish(): Promise<void>;
  /** Prevents new publication and waits for a publication already in flight. */
  cleanup(): Promise<void>;
}

export interface PublicationStore {
  create(destination: string, signal?: AbortSignal, localRoot?: string): Promise<FilePublication>;
}

export async function createFilePublication(
  destination: string, signal?: AbortSignal, localRoot?: string,
  writerRejectsSymlinks = false
): Promise<FilePublication> {
  signal?.throwIfAborted();
  const context = currentCrawlContext();
  const directories = context?.outputDirectories;
  let canonicalRoot: string | undefined;
  if (localRoot !== undefined) {
    const resolvedRoot = resolve(localRoot);
    const withinRoot = relative(resolvedRoot, resolve(destination));
    if (!withinRoot || withinRoot === '..' || withinRoot.startsWith('..' + sep) ||
      isAbsolute(withinRoot)) throw new Error('Output destination escapes localRoot');
    // The configured root is trusted and may itself be a symlink.
    canonicalRoot = await (directories ? directories.root(resolvedRoot) : resolveRoot(resolvedRoot));
    destination = join(canonicalRoot, withinRoot);
    await (directories ? directories.prepare(canonicalRoot, dirname(destination)) :
      checkDirectories(canonicalRoot, dirname(destination), true));
  }
  const parent = dirname(destination);
  if (canonicalRoot === undefined) await fs.mkdir(parent, {recursive: true});
  signal?.throwIfAborted();
  const reservationPath = context?.publicationReservations ?
    join(canonicalRoot === undefined ? await fs.realpath(parent) : parent, basename(destination)) : undefined;
  const release = context?.publicationOwner === undefined ? undefined :
    context.publicationReservations?.claim(process.platform === 'win32' ?
      reservationPath!.toLowerCase() : reservationPath!, context.publicationOwner);
  if (context?.directWrites) {
    try {
      if (!writerRejectsSymlinks) {
        // A direct writer must not follow an existing destination symlink.
        const stat = await lstat(destination).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return undefined;
        });
        if (stat?.isSymbolicLink()) throw new Error('Output destination must not be a symlink: ' + destination);
      }
    } catch (error) { release?.(false); throw error; }
    let published = false;
    let closed = false;
    return {stagingPath: destination, direct: true,
      async publish() {
        if (closed) throw new Error('Publication has been closed');
        signal?.throwIfAborted();
        if (!published) { published = true; recordResourcePublication(); }
      },
      async cleanup() {
        if (!closed) { closed = true; release?.(published); }
      }};
  }
  let staging: Awaited<ReturnType<StagingDirectories['acquire']>>;
  try {
    staging = await (context?.stagingDirectories ?? new StagingDirectories()).acquire(parent);
  } catch (error) { release?.(false); throw error; }
  const stagingPath = staging.path;
  let publishing: Promise<void> | undefined;
  let cleaning: Promise<void> | undefined;
  let published = false;
  return {
    stagingPath,
    publish() {
      if (cleaning) return Promise.reject(new Error('Publication has been closed'));
      publishing ??= (async () => {
        signal?.throwIfAborted();
        if (canonicalRoot !== undefined) await checkDirectories(canonicalRoot, parent, false);
        signal?.throwIfAborted();
        await fs.rename(stagingPath, destination);
        published = true;
        recordResourcePublication();
      })();
      return publishing;
    },
    cleanup() {
      cleaning ??= (async () => {
        // A failed rename must not prevent removal of the staging allocation.
        await publishing?.catch(() => undefined);
        await staging.cleanup(published);
        release?.(published);
      })();
      return cleaning;
    }
  };
}

/** Confirm successful output; atomic mode stages on the destination volume. */
export async function publishFile(
  destination: string,
  write: (stagingPath: string, direct?: boolean) => Promise<void | boolean>,
  signal?: AbortSignal,
  localRoot?: string,
  beforePublish?: () => Promise<boolean>,
  writerRejectsSymlinks = false
): Promise<boolean> {
  const store = currentCrawlContext()?.publicationStore;
  const publication = await (store ? store.create(destination, signal, localRoot) :
    createFilePublication(destination, signal, localRoot, writerRejectsSymlinks));
  try {
    signal?.throwIfAborted();
    if (publication.direct && beforePublish && !await beforePublish()) return false;
    if (await write(publication.stagingPath, publication.direct) === false) return false;
    signal?.throwIfAborted();
    if (!publication.direct && beforePublish && !await beforePublish()) return false;
    await publication.publish();
    return true;
  } finally {
    await publication.cleanup();
  }
}
