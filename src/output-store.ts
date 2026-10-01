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

/** Publish one file only after its writer succeeds. Staging stays on the same volume. */
export async function publishFile(
  destination: string,
  write: (stagingPath: string) => Promise<void>,
  signal?: AbortSignal,
  localRoot?: string,
  beforePublish?: () => Promise<boolean>
): Promise<boolean> {
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
  try {
    const stagingPath = join(stagingDirectory, 'content');
    signal?.throwIfAborted();
    await write(stagingPath);
    signal?.throwIfAborted();
    if (beforePublish && !await beforePublish()) return false;
    if (canonicalRoot !== undefined) await checkDirectories(canonicalRoot, parent, false);
    signal?.throwIfAborted();
    await fs.rename(stagingPath, destination);
    return true;
  } finally {
    await fs.rm(stagingDirectory, {recursive: true, force: true});
  }
}
