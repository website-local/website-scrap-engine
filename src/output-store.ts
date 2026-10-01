import {promises as fs} from 'node:fs';
import {dirname, join} from 'node:path';

/** Publish one file only after its writer succeeds. Staging stays on the same volume. */
export async function publishFile(
  destination: string,
  write: (stagingPath: string) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const parent = dirname(destination);
  await fs.mkdir(parent, {recursive: true});
  signal?.throwIfAborted();
  const stagingDirectory = await fs.mkdtemp(join(parent, '.wse-stage-'));
  try {
    const stagingPath = join(stagingDirectory, 'content');
    signal?.throwIfAborted();
    await write(stagingPath);
    signal?.throwIfAborted();
    await fs.rename(stagingPath, destination);
  } finally {
    await fs.rm(stagingDirectory, {recursive: true, force: true});
  }
}
