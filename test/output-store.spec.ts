import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import {promises as fs} from 'node:fs';
import {dirname, join} from 'node:path';
import {publishFile, createFilePublication, OutputDirectories, StagingDirectories} from '../src/output-store.js';
import {writeFile} from '../src/io.js';
import {createResource, ResourceType} from '../src/resource.js';
import {saveResourceToDisk} from '../src/life-cycle/save-resource-to-disk.js';
import {PublicationReservations} from '../src/publication-reservations.js';
import {withCrawlContext} from '../src/crawl-context.js';
import {createDefaultLogger} from '../src/logger/default-logger.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(process.cwd(), '.wse-output-test-')); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

test('direct output avoids staging and intentionally leaves partial failed writes', async () => {
  const destination = join(root, 'asset');
  await fs.writeFile(destination, 'cached');
  const context = {directWrites: true, outputDirectories: new OutputDirectories(),
    signal: new AbortController().signal, logger: createDefaultLogger()};
  await expect(withCrawlContext(context, () => publishFile(destination, async (target, direct) => {
    expect(direct).toBe(true);
    expect(target).toBe(destination);
    await fs.writeFile(target, 'partial');
    throw new Error('writer failed');
  }, undefined, root))).rejects.toThrow('writer failed');
  expect(await fs.readFile(destination, 'utf8')).toBe('partial');
  expect(await fs.readdir(root)).toEqual(['asset']);
});

test('direct output evaluates skip policy before touching a cached file', async () => {
  const destination = join(root, 'asset');
  await fs.writeFile(destination, 'cached');
  const context = {directWrites: true, signal: new AbortController().signal, logger: createDefaultLogger()};
  const saved = await withCrawlContext(context, () => publishFile(destination, async () => {
    throw new Error('writer must not run');
  }, undefined, root, async () => false));
  expect(saved).toBe(false);
  expect(await fs.readFile(destination, 'utf8')).toBe('cached');
});

test('direct output rejects an existing destination symlink', async () => {
  const target = join(root, 'target');
  const destination = join(root, 'alias');
  await fs.writeFile(target, 'cached');
  await fs.symlink(target, destination);
  const context = {directWrites: true, signal: new AbortController().signal, logger: createDefaultLogger()};
  await expect(withCrawlContext(context, () => writeFile(destination, 'new', 'utf8',
    undefined, undefined, root))).rejects.toThrow('symlink');
  expect(await fs.readFile(target, 'utf8')).toBe('cached');
});

describe('staged file publication', () => {
  test('keeps the previous file visible until all bytes are written', async () => {
    const destination = join(root, 'asset');
    await fs.writeFile(destination, 'old');
    await publishFile(destination, async staging => {
      await fs.writeFile(staging, 'new');
      expect(await fs.readFile(destination, 'utf8')).toBe('old');
      await fs.appendFile(staging, ' complete');
    });
    expect(await fs.readFile(destination, 'utf8')).toBe('new complete');
    expect(await fs.readdir(root)).toEqual(['asset']);
  });

  test.each(['error', 'cancel'])(
    '%s after partial writing preserves the destination and removes staging', async mode => {
      const destination = join(root, 'asset');
      await fs.writeFile(destination, 'cached');
      const controller = new AbortController();
      const failure = new Error('writer stopped');
      await expect(publishFile(destination, async staging => {
        await fs.writeFile(staging, 'partial');
        if (mode === 'error') throw failure;
        controller.abort(failure);
      }, controller.signal)).rejects.toBe(failure);
      expect(await fs.readFile(destination, 'utf8')).toBe('cached');
      expect(await fs.readdir(root)).toEqual(['asset']);
    });

  test('failed rename cleans staging without removing the destination', async () => {
    const destination = join(root, 'asset');
    await fs.mkdir(destination);
    await fs.writeFile(join(destination, 'existing'), 'keep');
    await expect(publishFile(destination, staging => fs.writeFile(staging, 'new'))).rejects.toThrow();
    expect(await fs.readFile(join(destination, 'existing'), 'utf8')).toBe('keep');
    expect(await fs.readdir(root)).toEqual(['asset']);
  });

  test('an already cancelled write creates no directories', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(publishFile(join(root, 'nested', 'asset'),
      staging => fs.writeFile(staging, 'new'), controller.signal)).rejects.toThrow('cancelled');
    expect(await fs.readdir(root)).toEqual([]);
  });

  test('the buffered writer preserves binary view bounds and epoch timestamps', async () => {
    const destination = join(root, 'nested', 'asset');
    const view = new DataView(new Uint8Array([99, 0, 255, 88]).buffer, 1, 2);
    await writeFile(destination, view, null, 0, 0);
    expect(await fs.readFile(destination)).toEqual(Buffer.from([0, 255]));
    expect((await fs.stat(destination)).mtimeMs).toBe(0);
    expect(await fs.readdir(join(root, 'nested'))).toEqual(['asset']);
  });

  test('rejects nested directory symlinks before creating files outside localRoot', async () => {
    const output = join(root, 'output');
    const outside = join(root, 'outside');
    await fs.mkdir(output);
    await fs.mkdir(outside);
    await fs.symlink(outside, join(output, 'example.test'), 'dir');
    const resource = {...createResource({
      type: ResourceType.Binary, depth: 0, url: 'https://example.test/deep/asset',
      refUrl: 'https://example.test/', localRoot: output
    }), body: 'new'};
    await expect(saveResourceToDisk(resource,
      {localRoot: output} as Parameters<typeof saveResourceToDisk>[1],
      {} as Parameters<typeof saveResourceToDisk>[2])).rejects.toThrow('symlink');
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await fs.readdir(output)).toEqual(['example.test']);
  });

  test('allows a configured root symlink and creates nested output inside its target', async () => {
    const output = join(root, 'output');
    const alias = join(root, 'alias');
    await fs.mkdir(output);
    await fs.symlink(output, alias, 'dir');
    await writeFile(join(alias, 'nested', 'asset'), 'new', 'utf8', undefined, undefined, alias);
    expect(await fs.readFile(join(output, 'nested', 'asset'), 'utf8')).toBe('new');
    expect(await fs.readdir(join(output, 'nested'))).toEqual(['asset']);
  });

  test('replaces a destination symlink without writing to its target', async () => {
    const outside = join(root, 'outside');
    const output = join(root, 'output');
    await fs.mkdir(output);
    await fs.writeFile(outside, 'keep');
    const destination = join(output, 'asset');
    await fs.symlink(outside, destination, 'file');
    await writeFile(destination, 'new', 'utf8', undefined, undefined, output);
    expect(await fs.readFile(outside, 'utf8')).toBe('keep');
    expect(await fs.readFile(destination, 'utf8')).toBe('new');
    expect((await fs.lstat(destination)).isSymbolicLink()).toBe(false);
  });

  test('rejects lexical escape before creating the configured root', async () => {
    const output = join(root, 'output');
    await expect(writeFile(join(root, 'asset'), 'new', 'utf8', undefined, undefined, output))
      .rejects.toThrow('escapes localRoot');
    expect(await fs.readdir(root)).toEqual([]);
  });

  test('concurrent publishers safely create shared missing directories', async () => {
    const output = join(root, 'missing', 'output');
    await Promise.all(Array.from({length: 16}, (_, index) =>
      writeFile(join(output, 'shared', 'nested', String(index)), String(index),
        'utf8', undefined, undefined, output)));
    const directory = join(output, 'shared', 'nested');
    expect((await fs.readdir(directory)).length).toBe(16);
    for (let index = 0; index < 16; index++) {
      expect(await fs.readFile(join(directory, String(index)), 'utf8')).toBe(String(index));
    }
  });
});


test('closing an unpublished allocation prevents late publication', async () => {
  const destination = join(root, 'asset');
  await fs.writeFile(destination, 'cached');
  const publication = await createFilePublication(destination, undefined, root);
  await fs.writeFile(publication.stagingPath, 'partial');
  const cleanup = publication.cleanup();
  expect(publication.cleanup()).toBe(cleanup);
  await cleanup;
  await expect(publication.publish()).rejects.toThrow('closed');
  expect(await fs.readFile(destination, 'utf8')).toBe('cached');
  expect(await fs.readdir(root)).toEqual(['asset']);
});

test('cleanup waits for an admitted publication and repeated publication shares its result', async () => {
  const destination = join(root, 'asset');
  const publication = await createFilePublication(destination, undefined, root);
  await fs.writeFile(publication.stagingPath, 'complete');
  const publishing = publication.publish();
  expect(publication.publish()).toBe(publishing);
  await publication.cleanup();
  await publishing;
  expect(await fs.readFile(destination, 'utf8')).toBe('complete');
  expect(await fs.readdir(root)).toEqual(['asset']);
});

test('destination ownership covers active writes, failures, retries and completed output', async () => {
  const context = {publicationReservations: new PublicationReservations(),
    signal: new AbortController().signal, logger: createDefaultLogger()};
  const destination = join(root, 'asset');
  const allocate = (owner: string) => withCrawlContext({...context, publicationOwner: owner},
    () => createFilePublication(destination, undefined, root));
  const first = await allocate('first');
  await expect(allocate('second')).rejects.toMatchObject({code: 'ERR_OUTPUT_CONFLICT'});
  await first.cleanup();
  const second = await allocate('second');
  await fs.writeFile(second.stagingPath, 'complete');
  await second.publish();
  await second.cleanup();
  await expect(allocate('first')).rejects.toMatchObject({code: 'ERR_OUTPUT_CONFLICT'});
  const retry = await allocate('second');
  await retry.cleanup();
  await expect(allocate('first')).rejects.toMatchObject({code: 'ERR_OUTPUT_CONFLICT'});
  expect(await fs.readFile(destination, 'utf8')).toBe('complete');
  expect(await fs.readdir(root)).toEqual(['asset']);
});

test('root aliases share destination ownership while independent crawls remain independent', async () => {
  const context = {publicationReservations: new PublicationReservations(),
    signal: new AbortController().signal, logger: createDefaultLogger()};
  const output = join(root, 'output');
  const alias = join(root, 'alias');
  await fs.mkdir(output);
  await fs.symlink(output, alias, 'dir');
  const first = await withCrawlContext({...context, publicationOwner: 'first'},
    () => createFilePublication(join(output, 'asset'), undefined, output));
  await expect(withCrawlContext({...context, publicationOwner: 'second'},
    () => createFilePublication(join(alias, 'asset'), undefined, alias)))
    .rejects.toMatchObject({code: 'ERR_OUTPUT_CONFLICT'});
  const independent = await withCrawlContext({...context, publicationOwner: 'second',
    publicationReservations: new PublicationReservations()},
  () => createFilePublication(join(alias, 'asset'), undefined, alias));
  await independent.cleanup();
  await first.cleanup();
  expect(await fs.readdir(output)).toEqual([]);
});

test('successful publication cleans extra files left by a custom writer', async () => {
  const destination = join(root, 'asset');
  await publishFile(destination, async staging => {
    await fs.writeFile(staging, 'complete');
    await fs.writeFile(join(staging, '..', 'extra'), 'scratch');
  });
  expect(await fs.readFile(destination, 'utf8')).toBe('complete');
  expect(await fs.readdir(root)).toEqual(['asset']);
});

test('rejects a directory alias even when its target stays inside the root', async () => {
  const target = join(root, 'target');
  await fs.mkdir(target);
  await fs.symlink(target, join(root, 'alias'), 'dir');
  await expect(writeFile(join(root, 'alias', 'asset'), 'new', 'utf8', undefined, undefined, root))
    .rejects.toThrow('symlink');
  expect(await fs.readdir(target)).toEqual([]);
});

test('rechecks directory symlinks immediately before publication', async () => {
  const parent = join(root, 'parent');
  const moved = join(root, 'moved');
  const target = join(root, 'target');
  await fs.mkdir(target);
  const publication = await createFilePublication(join(parent, 'asset'), undefined, root);
  await fs.writeFile(publication.stagingPath, 'complete');
  await fs.rename(parent, moved);
  await fs.symlink(target, parent, 'dir');
  try {
    await expect(publication.publish()).rejects.toThrow('symlink');
    expect(await fs.readdir(target)).toEqual([]);
  } finally {
    await fs.unlink(parent);
    await fs.rename(moved, parent);
    await publication.cleanup();
  }
  expect(await fs.readdir(parent)).toEqual([]);
});

test('overlapping publications share staging without deleting another writer on failure', async () => {
  const context = {stagingDirectories: new StagingDirectories(),
    signal: new AbortController().signal, logger: createDefaultLogger()};
  const [failed, successful] = await withCrawlContext(context, () => Promise.all([
    createFilePublication(join(root, 'failed'), undefined, root),
    createFilePublication(join(root, 'successful'), undefined, root)
  ]));
  expect(failed.stagingPath).not.toBe(successful.stagingPath);
  expect(dirname(failed.stagingPath)).toBe(dirname(successful.stagingPath));
  await fs.writeFile(failed.stagingPath, 'partial');
  await fs.writeFile(successful.stagingPath, 'complete');
  await failed.cleanup();
  expect(await fs.readFile(successful.stagingPath, 'utf8')).toBe('complete');
  await successful.publish();
  await successful.cleanup();
  expect(await fs.readdir(root)).toEqual(['successful']);
  const next = await withCrawlContext(context,
    () => createFilePublication(join(root, 'next'), undefined, root));
  expect(dirname(next.stagingPath)).not.toBe(dirname(successful.stagingPath));
  await next.cleanup();
  expect(await fs.readdir(root)).toEqual(['successful']);
});
