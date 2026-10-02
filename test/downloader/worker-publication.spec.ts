import {afterEach, beforeEach, expect, test} from '@jest/globals';
import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {MessageChannel} from 'node:worker_threads';
import type {Worker} from 'node:worker_threads';
import {WorkerPublicationClient, WorkerPublicationCoordinator} from '../../src/downloader/worker-publication.js';
import {createResourceProgress} from '../../src/crawl-context.js';
import {withCrawlContext} from '../../src/crawl-context.js';
import {noFollowWriteFlags, publishFile} from '../../src/output-store.js';
import {createDefaultLogger} from '../../src/logger/default-logger.js';
import {BufferBudget} from '../../src/buffer-budget.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(process.cwd(), '.wse-publication-test-')); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

function setup(directWrites = false) {
  const owners = new Map([[1, 101]]);
  const failures: Error[] = [];
  const coordinator = new WorkerPublicationCoordinator((worker, task) => owners.get(task) === worker,
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
  const progress = createResourceProgress();
  const budget = new BufferBudget(10);
  const bufferAccount = budget.reserve(0);
  const controller = new AbortController();
  coordinator.register(1, {logger: createDefaultLogger(), signal: controller.signal,
    resourceProgress: progress, bufferAccount, directWrites});
  return {owners, failures, coordinator, clients, workers, requests, progress, budget, bufferAccount, controller};
}

test('crawl cancellation rejects every allocation sharing a task lease', async () => {
  const {coordinator, clients, progress, controller} = setup();
  try {
    const handles = [];
    for (const name of ['first', 'second']) {
      const destination = join(root, name);
      await fs.writeFile(destination, 'cached');
      const handle = await clients[0].forTask(1).create(destination, undefined, root);
      await fs.writeFile(handle.stagingPath, 'replacement');
      handles.push(handle);
    }
    controller.abort(new Error('crawl cancelled'));
    for (const handle of handles) await expect(handle.publish()).rejects.toThrow('crawl cancelled');
    await coordinator.finish(1, false);
    expect(progress.publishedFiles).toBe(0);
    for (const name of ['first', 'second']) expect(await fs.readFile(join(root, name), 'utf8')).toBe('cached');
    expect((await fs.readdir(root)).sort()).toEqual(['first', 'second']);
  } finally {
    await coordinator.dispose();
    clients.forEach(client => client.close());
  }
});

test('foreign allocation and late publication cannot change cached output', async () => {
  const {owners, coordinator, clients, failures} = setup();
  try {
    const destination = join(root, 'asset');
    await fs.writeFile(destination, 'cached');
    await expect(clients[1].forTask(1).create(destination, undefined, root)).rejects.toThrow('owned');
    expect(await fs.readdir(root)).toEqual(['asset']);
    const handle = await clients[0].forTask(1).create(destination, undefined, root);
    await fs.writeFile(handle.stagingPath, 'partial');
    owners.delete(1);
    await coordinator.finish(1, false);
    await expect(handle.publish()).rejects.toThrow('owned');
    expect(await fs.readFile(destination, 'utf8')).toBe('cached');
    expect(await fs.readdir(root)).toEqual(['asset']);
    expect(failures).toEqual([]);
  } finally {
    await coordinator.dispose();
    clients.forEach(client => client.close());
  }
});

test('remote publication is confirmed in the parent context exactly once', async () => {
  const {coordinator, clients, progress} = setup();
  try {
    const destination = join(root, 'asset');
    const handle = await clients[0].forTask(1).create(destination, undefined, root);
    await fs.writeFile(handle.stagingPath, 'complete');
    const publishing = handle.publish();
    expect(handle.publish()).toBe(publishing);
    await publishing;
    await handle.cleanup();
    await coordinator.finish(1, false);
    expect(progress.publishedFiles).toBe(1);
    expect(await fs.readFile(destination, 'utf8')).toBe('complete');
    expect(await fs.readdir(root)).toEqual(['asset']);
  } finally {
    await coordinator.dispose();
    clients.forEach(client => client.close());
  }
});

(noFollowWriteFlags === undefined ? test.skip : test)('remote direct writers retain symlink rejection without a duplicate probe', async () => {
  const {coordinator, clients, progress} = setup(true);
  const target = join(root, 'target');
  const destination = join(root, 'asset');
  await fs.writeFile(target, 'cached');
  await fs.symlink(target, destination);
  let writerCalled = false;
  try {
    const context = {logger: createDefaultLogger(), signal: new AbortController().signal,
      publicationStore: clients[0].forTask(1)};
    const write = async (path: string) => {
      writerCalled = true;
      // Node accepts numeric flags although the Node 22 type omits them.
      await fs.writeFile(path, 'replacement', {flag: noFollowWriteFlags} as unknown as Parameters<typeof fs.writeFile>[2]);
    };
    // Generic writers must fail allocation before their callback can run.
    await expect(withCrawlContext(context, () => publishFile(destination, write, undefined, root)))
      .rejects.toThrow('symlink');
    expect(writerCalled).toBe(false);
    // The built-in no-follow writer rejects the same symlink at open instead.
    await expect(withCrawlContext(context, () => publishFile(destination, write, undefined, root, undefined, true)))
      .rejects.toMatchObject({code: 'ELOOP'});
    expect(writerCalled).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('cached');
    expect(progress.publishedFiles).toBe(0);
    await coordinator.finish(1, false);
  } finally {
    await coordinator.dispose();
    clients.forEach(client => client.close());
  }
});

test('worker byte reservations enforce parent ownership and preserve structured budget errors', async () => {
  const {coordinator, clients, budget, bufferAccount, owners} = setup();
  try {
    const account = clients[0].bufferForTask(1);
    await account.observeBody(4);
    await expect(clients[1].bufferForTask(1).reserveChild(1)).rejects.toThrow('owned');
    await account.reserveChild(6);
    await expect(account.observeBody(5)).rejects.toMatchObject({code: 'ERR_BUFFER_BUDGET', limit: 10, actual: 11});
    await expect(account.reserveChild(NaN)).rejects.toThrow('Invalid');
    expect(budget.used).toBe(10);
    owners.delete(1);
    await coordinator.finish(1, false);
    await expect(account.reserveChild(1)).rejects.toThrow('owned');
    bufferAccount.release();
    expect(budget.used).toBe(0);
  } finally {
    bufferAccount.release();
    await coordinator.dispose();
    clients.forEach(client => client.close());
  }
});

test.each([false, true])('successful publication releases its allocation in the parent (direct=%s)', async direct => {
  const {coordinator, clients, requests, progress} = setup(direct);
  try {
    const destination = join(root, 'asset');
    const handle = await clients[0].forTask(1).create(destination, undefined, root);
    await fs.writeFile(handle.stagingPath, 'complete');
    await handle.publish();
    // Atomic staging is already gone when the parent confirms publication.
    expect(await fs.readdir(root)).toEqual(['asset']);
    await handle.cleanup();
    await handle.cleanup();
    expect(requests).toEqual(['create', 'publish']);
    expect(progress.publishedFiles).toBe(1);
    await coordinator.finish(1, false);
    expect(await fs.readFile(destination, 'utf8')).toBe('complete');
  } finally {
    await coordinator.dispose();
    clients.forEach(client => client.close());
  }
});

test('failed worker allocations remain until the writer exits', async () => {
  const {coordinator, clients, workers} = setup();
  try {
    coordinator.assign(1, workers[0]);
    const destination = join(root, 'asset');
    await fs.writeFile(destination, 'cached');
    const handle = await clients[0].forTask(1).create(destination, undefined, root);
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
  } finally {
    workers[0].emit('exit', 1);
    await coordinator.dispose();
    clients.forEach(client => client.close());
  }
});

test('completed tasks with no allocations reject late publication requests', async () => {
  const {coordinator, clients, workers} = setup();
  try {
    coordinator.assign(1, workers[0]);
    await coordinator.finish(1, false);
    await coordinator.finish(1, false);
    await expect(clients[0].forTask(1).create(join(root, 'late'), undefined, root))
      .rejects.toThrow('owned');
    expect(await fs.readdir(root)).toEqual([]);
  } finally {
    workers[0].emit('exit', 0);
    await coordinator.dispose();
    clients.forEach(client => client.close());
  }
});

test('failed tasks without allocations still wait for worker exit before releasing credits', async () => {
  const {coordinator, clients, workers, bufferAccount, budget} = setup();
  try {
    coordinator.assign(1, workers[0]);
    bufferAccount.observeBody(4);
    const finishing = coordinator.finish(1, true);
    const released = finishing.then(() => bufferAccount.release());
    // A later successful close must not bypass an existing failure's exit wait.
    expect(coordinator.finish(1, false)).toBe(finishing);
    await new Promise(resolve => setImmediate(resolve));
    expect(budget.used).toBe(4);
    workers[0].emit('exit', 1);
    await released;
    expect(budget.used).toBe(0);
  } finally {
    workers[0].emit('exit', 1);
    await coordinator.dispose();
    bufferAccount.release();
    clients.forEach(client => client.close());
  }
});

test('successful close waits for pending operations even without allocations', async () => {
  const {coordinator, clients, workers, owners} = setup();
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let onStarted!: () => void;
  const started = new Promise<void>(resolve => { onStarted = resolve; });
  owners.set(2, workers[0].threadId);
  coordinator.register(2, {logger: createDefaultLogger(), signal: new AbortController().signal,
    bufferAccount: {observeBody: () => { onStarted(); return blocked; }, reserveChild: () => {}}});
  try {
    const reserving = clients[0].bufferForTask(2).observeBody(4);
    await started;
    let finished = false;
    const finishing = coordinator.finish(2, false).then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
    unblock();
    await reserving;
    await finishing;
    expect(finished).toBe(true);
    await expect(clients[0].bufferForTask(2).observeBody(5)).rejects.toThrow('owned');
  } finally {
    unblock();
    workers[0].emit('exit', 0);
    await coordinator.dispose();
    clients.forEach(client => client.close());
  }
});

test('assignment requires the attached worker object and rejects exited workers', async () => {
  const {coordinator, clients, workers, budget} = setup();
  try {
    expect(() => coordinator.assign(1, {threadId: workers[0].threadId} as Worker))
      .toThrow('no registered worker');
    workers[1].emit('exit', 0);
    expect(() => coordinator.assign(1, workers[1])).toThrow('no registered worker');
    coordinator.assign(1, workers[0]);
    await clients[0].bufferForTask(1).observeBody(4);
    expect(budget.used).toBe(4);
    await coordinator.finish(1, false);
  } finally {
    workers[0].emit('exit', 0);
    await coordinator.dispose();
    clients.forEach(client => client.close());
  }
});
