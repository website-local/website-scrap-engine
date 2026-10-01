import {recordResourcePublication} from './crawl-context.js';
import {promises as fs} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

async function checkDirectories(root: string, parent: string, create: boolean): Promise<void> {
  let current = root;
  for (const part of ['', ...relative(root, parent).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    if (create && part) {
      try { await fs.mkdir(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stat = await fs.lstat(current);
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
    await fs.mkdir(resolvedRoot, {recursive: true});
    // The configured root is trusted and may itself be a symlink.
    canonicalRoot = await fs.realpath(resolvedRoot);
    destination = join(canonicalRoot, withinRoot);
    await checkDirectories(canonicalRoot, dirname(destination), true);
  }
  const parent = dirname(destination);
  if (canonicalRoot === undefined) await fs.mkdir(parent, {recursive: true});
  signal?.throwIfAborted();
  const stagingDirectory = await fs.mkdtemp(join(parent, '.wse-stage-'));
  const stagingPath = join(stagingDirectory, 'content');
  let publishing: Promise<void> | undefined;
  let cleaning: Promise<void> | undefined;
  return {
    stagingPath,
    publish() {
      if (cleaning) return Promise.reject(new Error('Publication has been closed'));
      publishing ??= (async () => {
        signal?.throwIfAborted();
        if (canonicalRoot !== undefined) await checkDirectories(canonicalRoot, parent, false);
        signal?.throwIfAborted();
        await fs.rename(stagingPath, destination);
        recordResourcePublication();
      })();
      return publishing;
    },
    cleanup() {
      cleaning ??= (async () => {
        // A failed rename must not prevent removal of the staging allocation.
        await publishing?.catch(() => undefined);
        await fs.rm(stagingDirectory, {recursive: true, force: true});
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
  const publication = await createFilePublication(destination, signal, localRoot);
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
