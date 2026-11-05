import type {Resource} from './resource.js';
import type {AbstractDownloader} from './downloader/main.js';
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
  readonly roots = new Map<string, string | Promise<string>>();
  readonly parents = new Map<string, Promise<void> | null>();

  root(root: string): string | Promise<string> {
    let pending = this.roots.get(root);
    if (!pending) {
      pending = resolveRoot(root).then(value => {
        this.roots.set(root, value);
        return value;
      }, error => { this.roots.delete(root); throw error; });
      this.roots.set(root, pending);
    }
    return pending;
  }

  prepare(root: string, parent: string): void | Promise<void> {
    let pending = this.parents.get(parent);
    if (pending === null) return;
    if (!pending) {
      pending = checkDirectories(root, parent, true).then(() => {
        this.parents.set(parent, null);
      }, error => {
        this.parents.delete(parent);
        throw error;
      });
      this.parents.set(parent, pending);
    }
    return pending;
  }
}

/** Share a directory only while publications in the same parent overlap. */
export class StagingDirectories {
  readonly active = new Map<string, {directory: Promise<string>; references: number; next: number}>();

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
  /** Set writerRejectsSymlinks only when the writer opens with no-follow flags. */
  create(destination: string, signal?: AbortSignal, localRoot?: string,
    writerRejectsSymlinks?: boolean, resource?: Resource, publicationUrl?: string): Promise<FilePublication>;
}

export const outputConflict = (destination: string, owner: string): Error =>
  Object.assign(new Error('Output destination is already owned by ' + owner + ': ' + destination),
    {code: 'ERR_OUTPUT_CONFLICT', destination, owner});

/** Compare only competing canonical publications, without retaining their bodies. */
async function sameFileBytes(staging: string, destination: string, signal?: AbortSignal): Promise<boolean> {
  if ((await fs.lstat(destination)).isSymbolicLink()) {
    throw new Error('Output destination must not be a symlink: ' + destination);
  }
  const left = await fs.open(staging, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const right = await fs.open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const [a, b] = await Promise.all([left.stat(), right.stat()]);
      if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
      const first = Buffer.allocUnsafe(65536), second = Buffer.allocUnsafe(65536);
      const fill = async (file: typeof left, buffer: Buffer, position: number, length: number) => {
        let offset = 0;
        while (offset < length) {
          const {bytesRead} = await file.read(buffer, offset, length - offset, position + offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        return offset;
      };
      for (let position = 0; position < a.size; position += first.length) {
        signal?.throwIfAborted();
        const length = Math.min(first.length, a.size - position);
        const sizes = await Promise.all([fill(left, first, position, length), fill(right, second, position, length)]);
        if (sizes.some(size => size !== length) || !first.subarray(0, length).equals(second.subarray(0, length))) return false;
      }
      return true;
    } finally { await right.close(); }
  } finally { await left.close(); }
}

export async function createFilePublication(
  destination: string, signal?: AbortSignal, localRoot?: string,
  writerRejectsSymlinks = false, resource?: Resource, downloader?: AbstractDownloader, publicationUrl?: string
): Promise<FilePublication> {
  signal?.throwIfAborted();
  const directories = downloader?.outputDirectories;
  let canonicalRoot: string | undefined;
  if (localRoot !== undefined) {
    const resolvedRoot = resolve(localRoot);
    const resolvedDestination = resolve(destination);
    const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
    // Most destinations already share the normalized root spelling. Avoid
    // resolving both paths again inside relative() for that common case.
    const withinRoot = resolvedDestination.startsWith(rootPrefix) ?
      resolvedDestination.slice(rootPrefix.length) : relative(resolvedRoot, resolvedDestination);
    if (!withinRoot || withinRoot === '..' || withinRoot.startsWith('..' + sep) ||
      isAbsolute(withinRoot)) throw new Error('Output destination escapes localRoot');
    // The configured root is trusted and may itself be a symlink.
    const root = directories ? directories.root(resolvedRoot) : resolveRoot(resolvedRoot);
    canonicalRoot = typeof root === 'string' ? root : await root;
    destination = canonicalRoot === resolvedRoot ? resolvedDestination : join(canonicalRoot, withinRoot);
    const preparing = directories ? directories.prepare(canonicalRoot, dirname(destination)) :
      checkDirectories(canonicalRoot, dirname(destination), true);
    if (preparing) await preparing;
  }
  const parent = dirname(destination);
  if (canonicalRoot === undefined) await fs.mkdir(parent, {recursive: true});
  signal?.throwIfAborted();
  let reservationPath = downloader ? canonicalRoot === undefined ?
    join(await fs.realpath(parent), basename(destination)) : destination : undefined;
  if (reservationPath && process.platform === 'win32') reservationPath = reservationPath.toLowerCase();
  let comparing = false;
  if (reservationPath) {
    const owner = resource!.publicationOwner ?? resource!.url;
    const identity = publicationUrl === undefined ? undefined : publicationUrl === resource!.url ?
      owner : downloader!.canonicalUrl(publicationUrl);
    const claim = downloader!.claimOutput(reservationPath, owner, identity, signal);
    comparing = typeof claim === 'boolean' ? claim : await claim;
  }
  if (downloader && downloader.options.atomicWrites !== true && !comparing) {
    try {
      if (!writerRejectsSymlinks) {
        // A direct writer must not follow an existing destination symlink.
        const stat = await lstat(destination).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return undefined;
        });
        if (stat?.isSymbolicLink()) throw new Error('Output destination must not be a symlink: ' + destination);
      }
    } catch (error) { if (reservationPath) downloader!.releaseOutput(reservationPath, false); throw error; }
    let published = false;
    let closed = false;
    return {stagingPath: destination, direct: true,
      async publish() {
        if (closed) throw new Error('Publication has been closed');
        signal?.throwIfAborted();
        if (!published) { published = true; if (resource) resource.publishedFiles = (resource.publishedFiles ?? 0) + 1; }
      },
      async cleanup() {
        if (!closed) { closed = true; if (reservationPath) downloader!.releaseOutput(reservationPath, published); }
      }};
  }
  let staging: Awaited<ReturnType<StagingDirectories['acquire']>> | undefined;
  let stagingDirectory: string | undefined;
  let stagingPath: string;
  try {
    if (downloader) {
      staging = await downloader.stagingDirectories.acquire(parent);
      stagingPath = staging.path;
    } else {
      stagingDirectory = await fs.mkdtemp(join(parent, '.wse-stage-'));
      stagingPath = join(stagingDirectory, 'file');
    }
  } catch (error) { if (reservationPath) downloader!.releaseOutput(reservationPath, false); throw error; }
  let publishing: Promise<void> | undefined;
  let cleaning: Promise<void> | undefined;
  let published = false;
  let moved = false;
  return {
    stagingPath,
    publish() {
      if (cleaning) return Promise.reject(new Error('Publication has been closed'));
      publishing ??= (async () => {
        signal?.throwIfAborted();
        if (canonicalRoot !== undefined) await checkDirectories(canonicalRoot, parent, false);
        signal?.throwIfAborted();
        if (comparing) {
          if (!await sameFileBytes(stagingPath, destination, signal)) {
            throw outputConflict(destination, downloader!.outputReservations[reservationPath!].owner);
          }
          signal?.throwIfAborted();
        } else {
          await fs.rename(stagingPath, destination);
          moved = true;
        }
        published = true;
        if (resource) resource.publishedFiles = (resource.publishedFiles ?? 0) + 1;
      })();
      return publishing;
    },
    cleanup() {
      cleaning ??= (async () => {
        // A failed rename must not prevent removal of the staging allocation.
        await publishing?.catch(() => undefined);
        try {
          if (staging) await staging.cleanup(moved);
          else await fs.rm(stagingDirectory!, {recursive: true, force: true});
        } finally {
          if (reservationPath) downloader!.releaseOutput(reservationPath, published, comparing);
        }
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
  writerRejectsSymlinks = false, resource?: Resource, store?: PublicationStore, publicationUrl?: string
): Promise<boolean> {
  const publication = await (store ? store.create(destination, signal, localRoot, writerRejectsSymlinks, resource, publicationUrl) :
    createFilePublication(destination, signal, localRoot, writerRejectsSymlinks, resource));
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
