import {recordResourcePublication, currentCrawlContext} from './crawl-context.js';
import {promises as fs} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

async function checkDirectories(root: string, parent: string, create: boolean): Promise<void> {
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

/** A staging allocation whose publication and cleanup can be owned by another service. */
export interface FilePublication {
  readonly stagingPath: string;
  /** Starts at most once; repeated calls share the same operation. */
  publish(): Promise<void>;
  /** Prevents new publication and waits for a publication already in flight. */
  cleanup(): Promise<void>;
}

export interface PublicationStore {
  create(destination: string, signal?: AbortSignal, localRoot?: string): Promise<FilePublication>;
}

export async function createFilePublication(
  destination: string, signal?: AbortSignal, localRoot?: string
): Promise<FilePublication> {
  signal?.throwIfAborted();
  let canonicalRoot: string | undefined;
  if (localRoot !== undefined) {
    const resolvedRoot = resolve(localRoot);
    const withinRoot = relative(resolvedRoot, resolve(destination));
    if (!withinRoot || withinRoot === '..' || withinRoot.startsWith('..' + sep) ||
      isAbsolute(withinRoot)) throw new Error('Output destination escapes localRoot');
    // The configured root is trusted and may itself be a symlink.
    try { canonicalRoot = await fs.realpath(resolvedRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(resolvedRoot, {recursive: true});
      canonicalRoot = await fs.realpath(resolvedRoot);
    }
    destination = join(canonicalRoot, withinRoot);
    await checkDirectories(canonicalRoot, dirname(destination), true);
  }
  const parent = dirname(destination);
  if (canonicalRoot === undefined) await fs.mkdir(parent, {recursive: true});
  signal?.throwIfAborted();
  const context = currentCrawlContext();
  const reservationPath = context?.publicationReservations ?
    join(canonicalRoot === undefined ? await fs.realpath(parent) : parent, basename(destination)) : undefined;
  const release = context?.publicationOwner === undefined ? undefined :
    context.publicationReservations?.claim(process.platform === 'win32' ?
      reservationPath!.toLowerCase() : reservationPath!, context.publicationOwner);
  let stagingDirectory: string;
  try { stagingDirectory = await fs.mkdtemp(join(parent, '.wse-stage-')); }
  catch (error) { release?.(false); throw error; }
  const stagingPath = join(stagingDirectory, 'content');
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
        await fs.rm(stagingDirectory, {recursive: true, force: true});
        release?.(published);
      })();
      return cleaning;
    }
  };
}

/** Publish one file only after its writer succeeds. Staging stays on the same volume. */
export async function publishFile(
  destination: string,
  write: (stagingPath: string) => Promise<void>,
  signal?: AbortSignal,
  localRoot?: string,
  beforePublish?: () => Promise<boolean>
): Promise<boolean> {
  const store = currentCrawlContext()?.publicationStore;
  const publication = await (store ? store.create(destination, signal, localRoot) :
    createFilePublication(destination, signal, localRoot));
  try {
    signal?.throwIfAborted();
    await write(publication.stagingPath);
    signal?.throwIfAborted();
    if (beforePublish && !await beforePublish()) return false;
    await publication.publish();
    return true;
  } finally {
    await publication.cleanup();
  }
}
