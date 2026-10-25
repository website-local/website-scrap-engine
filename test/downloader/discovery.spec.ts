import {expect, jest, test} from '@jest/globals';
import {SingleThreadDownloader} from '../../src/downloader/single.js';
import type {SubmitResourceFunc} from '../../src/life-cycle/types.js';
import {createResource, ResourceType} from '../../src/resource.js';

const resource = (name: string) => createResource({type: ResourceType.Binary, depth: 0,
  url: 'https://example.test/' + name, refUrl: 'https://example.test/', localRoot: 'output'});
const optionsPath = new URL('./budget-options.js', import.meta.url).href;

test('one shared submission handler keeps concurrent parent counts independent', async () => {
  const downloader = new SingleThreadDownloader(optionsPath, {maxDiscoveredResources: 2, concurrency: 2});
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const handlers: SubmitResourceFunc[] = [];
  const parents = [resource('parent-a'), resource('parent-b')];
  try {
    await downloader.init;
    downloader.options.processAfterDownload = [async (res, submit, _options, pipeline) => {
      handlers.push(submit);
      submit(resource(res.url.endsWith('a') ? 'child-a' : 'child-b'), res, pipeline);
      if (handlers.length === 2) ready();
      await gate;
      expect(res.discoveredCount).toBe(1);
      return res;
    }];
    for (const parent of parents) parent.body = 'parent';
    const processing = parents.map(parent => downloader.downloadAndProcessResource(parent));
    await entered;
    expect(handlers).toEqual([downloader.submit, downloader.submit]);
    expect(parents.map(parent => parent.discoveredCount)).toEqual([1, 1]);
    release();
    await Promise.all(processing);
    expect(parents.map(parent => parent.discoveredCount)).toEqual([undefined, undefined]);
    expect(downloader.queueSize).toBe(2);
    expect(() => handlers[0](resource('late'), parents[0], downloader.pipeline)).toThrow('closed');
  } finally {
    release();
    await downloader.dispose();
  }
});

test('duplicate and batched submissions each count toward the parent limit', async () => {
  const downloader = new SingleThreadDownloader(optionsPath, {maxDiscoveredResources: 2});
  try {
    await downloader.init;
    const parent = resource('parent');
    parent.discoveredCount = 0;
    const rejected = resource('rejected');
    downloader.submit([resource('same'), resource('same'), rejected], parent, downloader.pipeline);
    expect(parent.discoveredCount).toBe(3);
    expect(downloader.queueSize).toBe(1);
    expect(rejected.shouldBeDiscardedFromDownload).toBe(true);
    expect(rejected.meta.error).toBeUndefined();
    downloader.submit(resource('later'), parent, downloader.pipeline);
    expect(parent.discoveredCount).toBe(4);
    expect(downloader.queueSize).toBe(1);
  } finally { await downloader.dispose(); }
});

test('oversized and queue-rejected children consume discovery counts before filtering', async () => {
  const downloader = new SingleThreadDownloader(optionsPath,
    {maxDiscoveredResources: 3, maxResourceBytes: 3, maxQueuedResources: 1});
  try {
    await downloader.init;
    const parent = resource('parent');
    parent.discoveredCount = 0;
    const oversized = {...resource('large'), body: Buffer.alloc(4)};
    const queued = resource('queue-full');
    const limited = resource('limit');
    const error = jest.spyOn(downloader, 'handleError');
    downloader.submit([oversized, resource('accepted'), queued, limited], parent, downloader.pipeline);
    expect(parent.discoveredCount).toBe(4);
    expect(downloader.queueSize).toBe(1);
    expect(oversized.meta).toMatchObject({resourceSize: 4, resourceSizeLimit: 3});
    for (const discarded of [oversized, queued, limited]) {
      expect(discarded.shouldBeDiscardedFromDownload).toBe(true);
      expect(discarded.meta.error).toBeUndefined();
    }
    expect(error).not.toHaveBeenCalled();
  } finally { await downloader.dispose(); }
});

test('closed and cancelled parents cannot submit late discoveries', async () => {
  const downloader = new SingleThreadDownloader(optionsPath);
  try {
    await downloader.init;
    const parent = resource('parent');
    expect(() => downloader.submit(resource('closed'), parent, downloader.pipeline)).toThrow('closed');
    parent.discoveredCount = 0;
    await downloader.dispose();
    expect(() => downloader.submit(resource('cancelled'), parent, downloader.pipeline)).toThrow();
    expect(parent.discoveredCount).toBe(0);
    expect(downloader.queueSize).toBe(0);
  } finally { await downloader.dispose(); }
});

test.each([false, true])('replacement parents close discovery after processing (failure=%s)', async fail => {
  const downloader = new SingleThreadDownloader(optionsPath);
  const parent = resource('parent');
  const replacement = {...resource('replacement'), body: 'replacement'};
  parent.body = 'parent';
  try {
    await downloader.init;
    downloader.options.processAfterDownload = [() => replacement, res => {
      downloader.submit(resource('accepted-child'), res, downloader.pipeline);
      if (fail) throw new Error('processing failed');
      return res;
    }];
    expect(await downloader.downloadAndProcessResource(parent)).toBe(fail ? false : undefined);
    expect(parent.discoveredCount).toBeUndefined();
    expect(replacement.discoveredCount).toBeUndefined();
    expect(() => downloader.submit(resource('late-child'), replacement, downloader.pipeline)).toThrow('closed');
    expect(downloader.queueSize).toBe(1);
  } finally { await downloader.dispose(); }
});
