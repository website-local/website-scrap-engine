import {describe, expect, test} from '@jest/globals';
import {AbstractDownloader} from '../../src/downloader/main.js';
import {adjust} from '../../src/downloader/adjust-concurrency.js';
import {defaultDownloadOptions} from '../../src/options.js';
import type {StaticDownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

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
}

const resource = (name: string) => createResource({type: ResourceType.Binary,
  depth: 0, url: 'https://example.test/' + name, refUrl: 'https://example.test/', localRoot: 'output'});

describe('crawl admission budgets', () => {
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
    for (const key of ['maxResources', 'maxQueuedResources', 'maxConcurrency']) {
      for (const value of [0, -1, 1.5, NaN, Infinity]) {
        expect(() => defaultDownloadOptions({...defaultLifeCycle(), [key]: value}))
          .toThrow(RangeError);
      }
    }
    expect(() => defaultDownloadOptions({...defaultLifeCycle(), minConcurrency: 3, maxConcurrency: 2}))
      .toThrow('minConcurrency exceeds maxConcurrency');
  });
});
