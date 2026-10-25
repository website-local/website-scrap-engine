import {describe, expect, jest, test} from '@jest/globals';
import {SingleThreadDownloader} from '../../src/downloader/single.js';
import {adjust} from '../../src/downloader/adjust-concurrency.js';
import {defaultDownloadOptions} from '../../src/options.js';
import type {StaticDownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {createResource, ResourceType} from '../../src/resource.js';

function crawler(options: Partial<StaticDownloadOptions>) {
  const downloader = new SingleThreadDownloader(new URL('./budget-options.js', import.meta.url).href, options);
  downloader.downloadAndProcessResource = async resource => { downloader.downloadedUrl.add(resource.url); };
  return downloader;
}

const resource = (name: string) => createResource({type: ResourceType.Binary,
  depth: 0, url: 'https://example.test/' + name, refUrl: 'https://example.test/', localRoot: 'output'});

describe('crawl admission limits', () => {
  test('validates body size before duplicate and queue limits', async () => {
    const downloader = crawler({maxResourceBytes: 3, maxQueuedResources: 1});
    try {
      await downloader.init;
      const first = {...resource('a'), body: 'abc', encoding: 'utf8' as const};
      expect(downloader.addProcessedResource(first)).toBe(true);
      for (const name of ['a', 'b']) {
        const oversized = {...resource(name), body: '😀', encoding: 'utf8' as const};
        expect(downloader.addProcessedResource(oversized)).toBe(false);
        expect(oversized.shouldBeDiscardedFromDownload).toBe(true);
        expect(oversized.meta).toMatchObject({resourceSize: 4, resourceSizeLimit: 3});
        expect(oversized.meta.error).toBeUndefined();
        expect(downloader.queueSize).toBe(1);
      }
      const duplicate = {...resource('a'), body: 'abc'};
      expect(downloader.addProcessedResource(duplicate)).toBe(false);
      expect(duplicate.meta.error).toBeUndefined();
      const queued = {...resource('b'), body: 'abc'};
      expect(downloader.addProcessedResource(queued)).toBe(false);
      expect(queued.shouldBeDiscardedFromDownload).toBe(true);
      expect(queued.meta.error).toBeUndefined();
      expect(downloader.queueSize).toBe(1);
    } finally { await downloader.dispose(); }
  });

  test('measures each admitted input independently with its current encoding', async () => {
    const downloader = crawler({maxResourceBytes: 3});
    try {
      await downloader.init;
      const res = {...resource('latin'), body: 'éé', encoding: 'latin1' as const};
      expect(downloader.addProcessedResource(res)).toBe(true);
      expect(downloader.addProcessedResource({...resource('empty'), body: ''})).toBe(true);
      expect(downloader.addProcessedResource(resource('undefined'))).toBe(true);
      expect(downloader.addProcessedResource({...resource('bytes'), body: Buffer.from([1, 2, 3])})).toBe(true);
      const changed = {...resource('utf8'), body: res.body, encoding: 'utf8' as const};
      expect(downloader.addProcessedResource(changed)).toBe(false);
      expect(changed.meta).toMatchObject({resourceSize: 4, resourceSizeLimit: 3});
      expect(downloader.queueSize).toBe(4);
      await downloader.start();
      await downloader.onIdle();
      expect(downloader.downloadedCount).toBe(4);
    } finally { await downloader.dispose(); }
  });

  test('starting a custom adjustment policy preserves its metadata', async () => {
    const downloader = crawler({concurrency: 1});
    try {
      await downloader.init;
      downloader.meta.firstPeriodCount = 99;
      downloader.options.adjustConcurrencyFunc = () => {};
      await downloader.start();
      expect(downloader.meta.firstPeriodCount).toBe(99);
    } finally { await downloader.dispose(); }
  });

  test('total admissions exclude duplicates and rejected resources', async () => {
    const downloader = crawler({maxResources: 2});
    try {
      await downloader.init;
      const error = jest.spyOn(downloader, 'handleError');
      expect(downloader.addProcessedResource(resource('a'))).toBe(true);
      expect(downloader.addProcessedResource(resource('a'))).toBe(false);
      expect(downloader.addProcessedResource(resource('b'))).toBe(true);
      const rejected = resource('c');
      expect(downloader.addProcessedResource(rejected)).toBe(false);
      expect(rejected.shouldBeDiscardedFromDownload).toBe(true);
      expect(rejected.meta.error).toBeUndefined();
      expect(error).not.toHaveBeenCalled();
      await downloader.start();
      await downloader.onIdle();
      expect(downloader.downloadedCount).toBe(2);
      expect(downloader.addProcessedResource(resource('c'))).toBe(false);
    } finally { await downloader.dispose(); }
  });

  test('a full waiting queue rejects discovery without blocking its active parent', async () => {
    const downloader = crawler({concurrency: 1, maxQueuedResources: 1});
    try {
      await downloader.init;
      downloader.downloadAndProcessResource = async res => {
        if (res.url.endsWith('/parent')) {
          expect(downloader.addProcessedResource(resource('child'))).toBe(true);
          expect(downloader.addProcessedResource(resource('later'))).toBe(false);
        }
        downloader.downloadedUrl.add(res.url);
      };
      expect(downloader.addProcessedResource(resource('parent'))).toBe(true);
      await downloader.start();
      await downloader.onIdle();
      expect(downloader.downloadedCount).toBe(2);
      expect(downloader.addProcessedResource(resource('later'))).toBe(true);
      await downloader.onIdle();
      expect(downloader.downloadedCount).toBe(3);
    } finally { await downloader.dispose(); }
  });

  test('initialization, setters, and automatic adjustment respect the concurrency ceiling', async () => {
    const downloader = crawler({maxConcurrency: 2});
    try {
      await downloader.init;
      expect(downloader.concurrency).toBe(2);
      downloader.concurrency = 100;
      expect(downloader.concurrency).toBe(2);
      expect(() => { downloader.concurrency = Infinity; }).toThrow(RangeError);
      downloader.addProcessedResource(resource('waiting'));
      downloader.meta.firstPeriodCount = 10;
      downloader.meta.currentPeriodCount = 10;
      adjust(downloader);
      expect(downloader.concurrency).toBe(2);
    } finally { await downloader.dispose(); }
  });

  test('rejects invalid limits and conflicting concurrency bounds', () => {
    for (const key of ['maxResources', 'maxQueuedResources', 'maxConcurrency', 'maxResourceBytes',
      'maxDiscoveredResources']) {
      for (const value of [0, -1, 1.5, NaN, Infinity]) {
        expect(() => defaultDownloadOptions({...defaultLifeCycle(), [key]: value})).toThrow(RangeError);
      }
    }
    expect(() => defaultDownloadOptions({...defaultLifeCycle(), minConcurrency: 3, maxConcurrency: 2}))
      .toThrow('minConcurrency exceeds maxConcurrency');
  });
});
