import {afterEach, beforeEach, expect, test} from '@jest/globals';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {SingleThreadDownloader} from '../src/downloader/single.js';
import {createFilePublication} from '../src/output-store.js';
import {createResource, ResourceType} from '../src/resource.js';

let root: string;
let downloader: SingleThreadDownloader;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'wse-alias-store-')); });
afterEach(async () => {
  if (downloader) await downloader.dispose();
  await fs.rm(root, {recursive: true, force: true});
});
const canonical = 'https://example.test/canonical.bin';
async function setup(atomicWrites: boolean) {
  downloader = new SingleThreadDownloader(new URL('./downloader/budget-options.js', import.meta.url).href,
    {localRoot: root, atomicWrites});
  await downloader.init;
  const destination = join(root, 'canonical.bin');
  const resource = (name: string) => createResource({type: ResourceType.Binary, depth: 0,
    url: 'https://example.test/' + name, refUrl: 'https://example.test/', localRoot: root});
  const first = resource('first.bin'), second = resource('second.bin');
  const allocate = (res = first, signal = downloader.signal, identity: string | undefined = canonical) =>
    createFilePublication(destination, signal, root, false, res, downloader, identity);
  return {destination, first, second, allocate};
}
async function noStages() {
  expect((await fs.readdir(root)).filter(name => name.startsWith('.wse-stage-'))).toEqual([]);
  expect(Object.values(downloader.outputReservations).every(value => value.active === 0 && !value.waiters?.size)).toBe(true);
}

test.each([false, true])('equal aliases wait for the active writer; shared retries preserve bytes (atomic %s)', async atomic => {
  const {destination, first, second, allocate} = await setup(atomic);
  const original = await allocate();
  await fs.writeFile(original.stagingPath, 'canonical bytes');
  let resolved = false;
  const pending = allocate(second).then(value => { resolved = true; return value; });
  await setImmediate();
  expect(resolved).toBe(false);
  await original.publish();
  await original.cleanup();
  const alias = await pending;
  expect(alias.direct).not.toBe(true);
  await fs.writeFile(alias.stagingPath, 'canonical bytes');
  await alias.publish();
  await alias.cleanup();
  expect(first.publishedFiles).toBe(1);
  expect(second.publishedFiles).toBe(1);
  const retry = await allocate(first);
  await fs.writeFile(retry.stagingPath, 'different bytes');
  await expect(retry.publish()).rejects.toMatchObject({code: 'ERR_OUTPUT_CONFLICT'});
  await retry.cleanup();
  expect(await fs.readFile(destination, 'utf8')).toBe('canonical bytes');
  await noStages();
});

test.each([false, true])('a failed earlier writer releases an identical-identity contender (atomic %s)', async atomic => {
  const {destination, second, allocate} = await setup(atomic);
  const first = await allocate();
  await fs.writeFile(first.stagingPath, 'partial');
  const pending = allocate(second);
  await setImmediate();
  await first.cleanup();
  const replacement = await pending;
  await fs.writeFile(replacement.stagingPath, 'complete');
  await replacement.publish();
  await replacement.cleanup();
  expect(await fs.readFile(destination, 'utf8')).toBe('complete');
  await noStages();
});

test.each([false, true])('cancelling a waiting contender removes its waiter (atomic %s)', async atomic => {
  const {second, allocate} = await setup(atomic);
  const first = await allocate();
  const controller = new AbortController();
  const error = new Error('Contender cancelled');
  const pending = allocate(second, controller.signal);
  const rejected = expect(pending).rejects.toBe(error);
  await setImmediate();
  controller.abort(error);
  await rejected;
  await first.cleanup();
  expect(downloader.outputReservations).toEqual({});
  await noStages();
});

test.each([false, true])('cancelling the earlier writer unblocks the next publication (atomic %s)', async atomic => {
  const {destination, first, second, allocate} = await setup(atomic);
  const controller = new AbortController();
  const original = await allocate(first, controller.signal);
  await fs.writeFile(original.stagingPath, 'partial');
  const pending = allocate(second);
  await setImmediate();
  const error = new Error('First writer cancelled');
  controller.abort(error);
  await expect(original.publish()).rejects.toBe(error);
  await original.cleanup();
  const replacement = await pending;
  await fs.writeFile(replacement.stagingPath, 'complete');
  await replacement.publish();
  await replacement.cleanup();
  expect(await fs.readFile(destination, 'utf8')).toBe('complete');
  await noStages();
});

test.each([false, true])('a different-content contender removes its stage and preserves prior bytes (atomic %s)', async atomic => {
  const {destination, second, allocate} = await setup(atomic);
  const original = await allocate();
  await fs.writeFile(original.stagingPath, 'keep');
  await original.publish();
  await original.cleanup();
  const contender = await allocate(second);
  await fs.writeFile(contender.stagingPath, 'stop');
  await expect(contender.publish()).rejects.toMatchObject({code: 'ERR_OUTPUT_CONFLICT'});
  await contender.cleanup();
  expect(await fs.readFile(destination, 'utf8')).toBe('keep');
  await expect(fs.access(contender.stagingPath)).rejects.toMatchObject({code: 'ENOENT'});
  await noStages();
});
