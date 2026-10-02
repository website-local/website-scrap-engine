import {describe, expect, test} from '@jest/globals';
import {AbstractDownloader} from '../../src/downloader/main.js';
import {adjust} from '../../src/downloader/adjust-concurrency.js';
import {defaultDownloadOptions} from '../../src/options.js';
import type {StaticDownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';
import type {BufferReservation} from '../../src/buffer-budget.js';
import {currentCrawlContext} from '../../src/crawl-context.js';

class Crawler extends AbstractDownloader {
  work: (resource: Resource) => Promise<void> = async resource => {
    this.downloadedUrl.add(resource.url);
  };
  constructor(options: Partial<StaticDownloadOptions>) {
    super(new URL('./budget-options.js', import.meta.url).href, options);
  }
  async downloadAndProcessResource(resource: Resource): Promise<void> {
    await this.work(resource);
  }
  admitChild(resource: Resource, credit: BufferReservation): boolean | void {
    return this._addProcessedResource(resource, credit);
  }
}

const resource = (name: string) => createResource({type: ResourceType.Binary,
  depth: 0, url: 'https://example.test/' + name, refUrl: 'https://example.test/', localRoot: 'output'});

describe('crawl admission budgets', () => {
  test('validates body size before duplicate, queue and buffer limits without consuming credits', async () => {
    const crawler = new Crawler({maxResourceBytes: 3, maxBufferedBytes: 3, maxQueuedResources: 1});
    try {
      await crawler._initOptions;
      const first = {...resource('a'), body: 'abc', encoding: 'utf8' as const};
      expect(crawler.addProcessedResource(first)).toBe(true);
      for (const name of ['a', 'b']) {
        const oversized = {...resource(name), body: '😀', encoding: 'utf8' as const};
        expect(crawler.addProcessedResource(oversized)).toBe(false);
        expect(oversized.meta.error).toMatchObject({code: 'ERR_RESOURCE_SIZE_LIMIT', actual: 4, limit: 3});
        expect(crawler.bufferedBytes).toBe(3);
        expect(crawler.queueSize).toBe(1);
      }
      const duplicate = {...resource('a'), body: 'abc'};
      expect(crawler.addProcessedResource(duplicate)).toBe(false);
      expect(duplicate.meta.error).toBeUndefined();
      const queued = {...resource('b'), body: 'abc'};
      expect(crawler.addProcessedResource(queued)).toBe(false);
      expect(queued.meta.error).toMatchObject({code: 'ERR_CRAWL_LIMIT', limit: 'maxQueuedResources'});
      expect(crawler.bufferedBytes).toBe(3);
    } finally { await crawler.dispose(); }
    expect(crawler.bufferedBytes).toBe(0);
  });

  test.each([undefined, 4])('accounts current bodies and encodings with resource limit %s', async maxResourceBytes => {
    const crawler = new Crawler({maxResourceBytes, maxBufferedBytes: 4});
    try {
      await crawler._initOptions;
      const res = {...resource('a'), body: 'éé', encoding: 'latin1' as const};
      expect(crawler.addProcessedResource(res)).toBe(true);
      expect(crawler.bufferedBytes).toBe(2);
      const empty = {...resource('empty'), body: ''};
      expect(crawler.addProcessedResource(empty)).toBe(true);
      expect(crawler.addProcessedResource(resource('undefined'))).toBe(true);
      const bytes = {...resource('bytes'), body: Buffer.from([1, 2])};
      expect(crawler.addProcessedResource(bytes)).toBe(true);
      expect(crawler.bufferedBytes).toBe(4);
      const overflow = {...resource('overflow'), body: 'x'};
      expect(crawler.addProcessedResource(overflow)).toBe(false);
      expect(overflow.meta.error).toMatchObject({code: 'ERR_BUFFER_BUDGET', actual: 5, limit: 4});
      expect(crawler.bufferedBytes).toBe(4);
      await crawler.start();
      await crawler.onIdle();
      expect(crawler.bufferedBytes).toBe(0);
      // A new admission must measure the updated body and encoding.
      res.url = 'https://example.test/new';
      res.uri = res.uri.clone().path('/new');
      const changed = {...res, body: '😀', encoding: 'utf8' as const};
      crawler.stop();
      expect(crawler.addProcessedResource(changed)).toBe(true);
      expect(crawler.bufferedBytes).toBe(4);
    } finally { await crawler.dispose(); }
    expect(crawler.bufferedBytes).toBe(0);
  });

  test('transfers pre-reserved child bytes without double charging at the full limit', async () => {
    const crawler = new Crawler({concurrency: 1, maxResourceBytes: 4, maxBufferedBytes: 4});
    try {
      await crawler._initOptions;
      crawler.work = async res => {
        if (!res.url.endsWith('/parent')) return;
        const credit = currentCrawlContext()!.bufferAccount as BufferReservation;
        credit.reserveChild(4);
        expect(crawler.bufferedBytes).toBe(4);
        const child = {...resource('child'), body: '😀', encoding: 'utf8' as const};
        expect(crawler.admitChild(child, credit)).toBe(true);
        expect(credit.childBytes).toBe(0);
        expect(crawler.bufferedBytes).toBe(4);
      };
      expect(crawler.addProcessedResource(resource('parent'))).toBe(true);
      await crawler.start();
      await crawler.onIdle();
      expect(crawler.outcomes.size).toBe(2);
      expect(crawler.peakBufferedBytes).toBe(4);
      expect(crawler.bufferedBytes).toBe(0);
    } finally { await crawler.dispose(); }
  });

  test('starting a custom adjustment policy preserves its metadata', async () => {
    const crawler = new Crawler({concurrency: 1});
    try {
      await crawler._initOptions;
      crawler.meta.firstPeriodCount = 99;
      crawler.options.adjustConcurrencyFunc = () => {};
      await crawler.start();
      expect(crawler.meta.firstPeriodCount).toBe(99);
    } finally { await crawler.dispose(); }
  });
  test('total admissions exclude duplicates and rejected resources', async () => {
    const crawler = new Crawler({maxResources: 2});
    try {
      await crawler._initOptions;
      const failures: unknown[] = [];
      crawler.options.statusChange.push((res, status) => {
        if (status === 'error') failures.push(res.meta.error);
      });
      expect(crawler.addProcessedResource(resource('a'))).toBe(true);
      expect(crawler.addProcessedResource(resource('a'))).toBe(false);
      expect(crawler.addProcessedResource(resource('b'))).toBe(true);
      expect(crawler.addProcessedResource(resource('c'))).toBe(false);
      expect(failures).toEqual([expect.objectContaining({code: 'ERR_CRAWL_LIMIT', limit: 'maxResources'})]);
      await crawler.start();
      await crawler.onIdle();
      expect(crawler.downloadedCount).toBe(2);
      expect(crawler.addProcessedResource(resource('c'))).toBe(false);
    } finally { await crawler.dispose(); }
  });

  test('a full waiting queue rejects discovery without blocking its active parent', async () => {
    const crawler = new Crawler({concurrency: 1, maxQueuedResources: 1});
    try {
      await crawler._initOptions;
      crawler.work = async res => {
        if (res.url.endsWith('/parent')) {
          expect(crawler.addProcessedResource(resource('child'))).toBe(true);
          expect(crawler.addProcessedResource(resource('later'))).toBe(false);
        }
        crawler.downloadedUrl.add(res.url);
      };
      expect(crawler.addProcessedResource(resource('parent'))).toBe(true);
      await crawler.start();
      await crawler.onIdle();
      expect(crawler.downloadedCount).toBe(2);
      expect(crawler.addProcessedResource(resource('later'))).toBe(true);
      await crawler.onIdle();
      expect(crawler.downloadedCount).toBe(3);
    } finally { await crawler.dispose(); }
  });

  test('initialization, setters, and automatic adjustment respect the concurrency ceiling', async () => {
    const crawler = new Crawler({maxConcurrency: 2});
    try {
      await crawler._initOptions;
      expect(crawler.concurrency).toBe(2);
      crawler.concurrency = 100;
      expect(crawler.concurrency).toBe(2);
      expect(() => { crawler.concurrency = Infinity; }).toThrow(RangeError);
      crawler.addProcessedResource(resource('waiting'));
      crawler.meta.firstPeriodCount = 10;
      crawler.meta.currentPeriodCount = 10;
      adjust(crawler);
      expect(crawler.concurrency).toBe(2);
    } finally { await crawler.dispose(); }
  });

  test('rejects invalid budgets and conflicting concurrency bounds', () => {
    for (const key of ['maxResources', 'maxQueuedResources', 'maxConcurrency', 'maxResourceBytes',
      'maxDiscoveredResources', 'maxBufferedBytes']) {
      for (const value of [0, -1, 1.5, NaN, Infinity]) {
        expect(() => defaultDownloadOptions({...defaultLifeCycle(), [key]: value}))
          .toThrow(RangeError);
      }
    }
    expect(() => defaultDownloadOptions({...defaultLifeCycle(), minConcurrency: 3, maxConcurrency: 2}))
      .toThrow('minConcurrency exceeds maxConcurrency');
  });
});
