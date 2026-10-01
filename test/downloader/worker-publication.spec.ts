import {afterEach, beforeEach, expect, test} from '@jest/globals';
import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {MessageChannel} from 'node:worker_threads';
import type {Worker} from 'node:worker_threads';
import {WorkerPublicationClient, WorkerPublicationCoordinator} from '../../src/downloader/worker-publication.js';
import {createResourceProgress} from '../../src/crawl-context.js';
import {createDefaultLogger} from '../../src/logger/default-logger.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(process.cwd(), '.wse-publication-test-')); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

function setup() {
  const owners = new Map([[1, 101]]);
  const failures: Error[] = [];
  const coordinator = new WorkerPublicationCoordinator((worker, task) => owners.get(task) === worker,
    (_worker, error) => { failures.push(error); });
  const clients = [101, 102].map(id => {
    const channel = new MessageChannel();
    coordinator.attach(Object.assign(new EventEmitter(), {threadId: id}) as unknown as Worker, channel.port1);
    return new WorkerPublicationClient(channel.port2);
  });
  const progress = createResourceProgress();
  coordinator.register(1, {logger: createDefaultLogger(), signal: new AbortController().signal,
    resourceProgress: progress});
  return {owners, failures, coordinator, clients, progress};
}

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
