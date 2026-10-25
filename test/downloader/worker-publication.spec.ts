import {afterEach, beforeEach, expect, jest, test} from '@jest/globals';
import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MessageChannel} from 'node:worker_threads';
import type {Worker} from 'node:worker_threads';
import {WorkerPublicationClient, WorkerPublicationCoordinator} from '../../src/downloader/worker-publication.js';
import {SingleThreadDownloader} from '../../src/downloader/single.js';
import {createResource, ResourceType} from '../../src/resource.js';
import {noFollowWriteFlags, publishFile} from '../../src/output-store.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'wse-publication-test-')); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

async function setup(directWrites = false) {
  const downloader = new SingleThreadDownloader(new URL('./budget-options.js', import.meta.url).href,
    {localRoot: root, atomicWrites: !directWrites});
  await downloader.init;
  const owners: Record<number, number> = {1: 101};
  const failures: Error[] = [];
  const coordinator = new WorkerPublicationCoordinator(downloader, (worker, task) => owners[task] === worker,
    (_worker, error) => { failures.push(error); });
  const workers: Worker[] = [];
  const requests: string[] = [];
  const clients = [101, 102].map(id => {
    const channel = new MessageChannel();
    const worker = Object.assign(new EventEmitter(), {threadId: id}) as unknown as Worker;
    workers.push(worker);
    channel.port1.on('message', request => requests.push(request.operation));
    coordinator.attach(worker, channel.port1);
    return new WorkerPublicationClient(channel.port2);
  });
  const resource = createResource({type: ResourceType.Binary, depth: 0,
    url: 'https://example.test/asset', refUrl: 'https://example.test/', localRoot: root});
  resource.publishedFiles = 0;
  const workerResource = {...resource, workerTaskId: 1};
  coordinator.register(1, resource);
  return {downloader, owners, failures, coordinator, clients, workers, requests, resource, workerResource};
}

async function cleanup(state: Awaited<ReturnType<typeof setup>>) {
  state.workers.forEach(worker => worker.emit('exit', 0));
  await state.coordinator.dispose();
  state.clients.forEach(client => client.close());
  await state.downloader.dispose();
}

test('crawl cancellation rejects every allocation sharing a task lease', async () => {
  const state = await setup();
  const {coordinator, clients, resource, workerResource, downloader} = state;
  try {
    const handles = [];
    for (const name of ['first', 'second']) {
      const destination = join(root, name);
      await fs.writeFile(destination, 'cached');
      const handle = await clients[0].create(destination, undefined, root, false, workerResource);
      await fs.writeFile(handle.stagingPath, 'replacement');
      handles.push(handle);
    }
    await downloader.dispose();
    for (const handle of handles) await expect(handle.publish()).rejects.toThrow('Downloader disposed');
    await coordinator.finish(1, false);
    expect(resource.publishedFiles).toBe(0);
    for (const name of ['first', 'second']) expect(await fs.readFile(join(root, name), 'utf8')).toBe('cached');
    expect((await fs.readdir(root)).sort()).toEqual(['first', 'second']);
  } finally { await cleanup(state); }
});

test('foreign allocation and late publication cannot change cached output', async () => {
  const state = await setup();
  const {owners, coordinator, clients, failures, workerResource} = state;
  try {
    const destination = join(root, 'asset');
    await fs.writeFile(destination, 'cached');
    await expect(clients[1].create(destination, undefined, root, false, workerResource)).rejects.toThrow('owned');
    expect(await fs.readdir(root)).toEqual(['asset']);
    const handle = await clients[0].create(destination, undefined, root, false, workerResource);
    await fs.writeFile(handle.stagingPath, 'partial');
    delete owners[1];
    await coordinator.finish(1, false);
    await expect(handle.publish()).rejects.toThrow('owned');
    expect(await fs.readFile(destination, 'utf8')).toBe('cached');
    expect(await fs.readdir(root)).toEqual(['asset']);
    expect(failures).toEqual([]);
  } finally { await cleanup(state); }
});

test('remote publication is counted on the parent resource exactly once', async () => {
  const state = await setup();
  const {coordinator, clients, resource, workerResource} = state;
  try {
    const destination = join(root, 'asset');
    const handle = await clients[0].create(destination, undefined, root, false, workerResource);
    await fs.writeFile(handle.stagingPath, 'complete');
    const publishing = handle.publish();
    expect(handle.publish()).toBe(publishing);
    await publishing;
    await handle.cleanup();
    await coordinator.finish(1, false);
    expect(resource.publishedFiles).toBe(1);
    expect(workerResource.publishedFiles).toBe(0);
    expect(await fs.readFile(destination, 'utf8')).toBe('complete');
    expect(await fs.readdir(root)).toEqual(['asset']);
  } finally { await cleanup(state); }
});

(noFollowWriteFlags === undefined ? test.skip : test)('remote direct writers retain symlink rejection without a duplicate probe', async () => {
  const state = await setup(true);
  const {coordinator, clients, resource, workerResource} = state;
  const target = join(root, 'target');
  const destination = join(root, 'asset');
  await fs.writeFile(target, 'cached');
  await fs.symlink(target, destination);
  let writerCalled = false;
  try {
    const write = async (path: string) => {
      writerCalled = true;
      // Node accepts numeric flags although the Node 22 type omits them.
      await fs.writeFile(path, 'replacement', {flag: noFollowWriteFlags} as unknown as Parameters<typeof fs.writeFile>[2]);
    };
    // Generic writers must fail allocation before their callback can run.
    await expect(publishFile(destination, write, undefined, root, undefined, false, workerResource, clients[0]))
      .rejects.toThrow('symlink');
    expect(writerCalled).toBe(false);
    // The built-in no-follow writer rejects the same symlink at open instead.
    await expect(publishFile(destination, write, undefined, root, undefined, true, workerResource, clients[0]))
      .rejects.toMatchObject({code: 'ELOOP'});
    expect(writerCalled).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('cached');
    expect(resource.publishedFiles).toBe(0);
    await coordinator.finish(1, false);
  } finally { await cleanup(state); }
});

test('worker output conflicts retain their error code and release failed ownership', async () => {
  const state = await setup();
  const {coordinator, clients, owners, resource, workerResource} = state;
  const second = {...resource, url: 'https://example.test/second', workerTaskId: 2};
  owners[2] = 102;
  coordinator.register(2, second);
  try {
    const destination = join(root, 'asset');
    const first = await clients[0].create(destination, undefined, root, false, workerResource);
    await expect(clients[1].create(destination, undefined, root, false, second))
      .rejects.toMatchObject({code: 'ERR_OUTPUT_CONFLICT'});
    await first.cleanup();
    const replacement = await clients[1].create(destination, undefined, root, false, second);
    await fs.writeFile(replacement.stagingPath, 'complete');
    await replacement.publish();
    await replacement.cleanup();
    await expect(clients[0].create(destination, undefined, root, false, workerResource))
      .rejects.toMatchObject({code: 'ERR_OUTPUT_CONFLICT'});
    expect(await fs.readFile(destination, 'utf8')).toBe('complete');
    expect(resource.publishedFiles).toBe(0);
    expect(second.publishedFiles).toBe(1);
    await coordinator.finish(1, false);
    await coordinator.finish(2, false);
  } finally { await cleanup(state); }
});

test.each([false, true])('successful publication releases its allocation in the parent (direct=%s)', async direct => {
  const state = await setup(direct);
  const {coordinator, clients, requests, resource, workerResource} = state;
  try {
    const destination = join(root, 'asset');
    const handle = await clients[0].create(destination, undefined, root, false, workerResource);
    await fs.writeFile(handle.stagingPath, 'complete');
    await handle.publish();
    // Atomic staging is already gone when the parent confirms publication.
    expect(await fs.readdir(root)).toEqual(['asset']);
    await handle.cleanup();
    await handle.cleanup();
    expect(requests).toEqual(['create', 'publish']);
    expect(resource.publishedFiles).toBe(1);
    await coordinator.finish(1, false);
    expect(await fs.readFile(destination, 'utf8')).toBe('complete');
  } finally { await cleanup(state); }
});

test('failed worker allocations remain until the writer exits', async () => {
  const state = await setup();
  const {coordinator, clients, workers, workerResource} = state;
  try {
    coordinator.assign(1, workers[0]);
    const destination = join(root, 'asset');
    await fs.writeFile(destination, 'cached');
    const handle = await clients[0].create(destination, undefined, root, false, workerResource);
    await fs.writeFile(handle.stagingPath, 'partial');
    let finished = false;
    const finishing = coordinator.finish(1, true).then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(await fs.readFile(handle.stagingPath, 'utf8')).toBe('partial');
    workers[0].emit('exit', 1);
    await finishing;
    expect(await fs.readdir(root)).toEqual(['asset']);
    expect(await fs.readFile(destination, 'utf8')).toBe('cached');
  } finally { await cleanup(state); }
});

test('completed tasks with no allocations reject late publication requests', async () => {
  const state = await setup();
  const {coordinator, clients, workers, workerResource} = state;
  try {
    coordinator.assign(1, workers[0]);
    await coordinator.finish(1, false);
    await coordinator.finish(1, false);
    await expect(clients[0].create(join(root, 'late'), undefined, root, false, workerResource)).rejects.toThrow('owned');
    expect(await fs.readdir(root)).toEqual([]);
  } finally { await cleanup(state); }
});

test('failed tasks without allocations retain their lease until worker exit', async () => {
  const state = await setup();
  const {coordinator, workers} = state;
  try {
    coordinator.assign(1, workers[0]);
    const finishing = coordinator.finish(1, true);
    let finished = false;
    void finishing.then(() => { finished = true; });
    // A later successful close must not bypass an existing failure's exit wait.
    expect(coordinator.finish(1, false)).toBe(finishing);
    await new Promise(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(coordinator.leases.has(1)).toBe(true);
    workers[0].emit('exit', 1);
    await finishing;
    expect(finished).toBe(true);
    expect(coordinator.leases.has(1)).toBe(false);
  } finally { await cleanup(state); }
});

test('successful close waits for a pending allocation and removes its staging', async () => {
  const state = await setup();
  const {coordinator, clients, workerResource, downloader} = state;
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let onStarted!: () => void;
  const started = new Promise<void>(resolve => { onStarted = resolve; });
  const acquire = downloader.stagingDirectories.acquire.bind(downloader.stagingDirectories);
  const allocating = jest.spyOn(downloader.stagingDirectories, 'acquire').mockImplementation(async parent => {
    onStarted();
    await blocked;
    return acquire(parent);
  });
  try {
    const creating = clients[0].create(join(root, 'asset'), undefined, root, false, workerResource);
    const rejected = expect(creating).rejects.toThrow('cancelled');
    await started;
    let finished = false;
    const finishing = coordinator.finish(1, false).then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
    unblock();
    await rejected;
    await finishing;
    expect(finished).toBe(true);
    expect(await fs.readdir(root)).toEqual([]);
    await expect(clients[0].create(join(root, 'late'), undefined, root, false, workerResource)).rejects.toThrow('owned');
  } finally {
    unblock();
    allocating.mockRestore();
    await cleanup(state);
  }
});

test('assignment requires the attached worker object and rejects exited workers', async () => {
  const state = await setup();
  const {coordinator, clients, workers, workerResource} = state;
  try {
    expect(() => coordinator.assign(1, {threadId: workers[0].threadId} as Worker))
      .toThrow('no registered worker');
    workers[1].emit('exit', 0);
    expect(() => coordinator.assign(1, workers[1])).toThrow('no registered worker');
    coordinator.assign(1, workers[0]);
    const handle = await clients[0].create(join(root, 'asset'), undefined, root, false, workerResource);
    await fs.writeFile(handle.stagingPath, 'complete');
    await handle.publish();
    await handle.cleanup();
    expect(await fs.readFile(join(root, 'asset'), 'utf8')).toBe('complete');
    await coordinator.finish(1, false);
  } finally { await cleanup(state); }
});
