import {describe, expect, test} from '@jest/globals';
import {AbstractDownloader} from '../../src/downloader/main.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

class Crawler extends AbstractDownloader {
  work: (resource: Resource) => Promise<boolean | void> = async () => undefined;
  constructor(stripSearch: boolean) {
    super(new URL('./budget-options.js', import.meta.url).href,
      {concurrency: 2, deduplicateStripSearch: stripSearch});
  }
  async downloadAndProcessResource(resource: Resource): Promise<boolean | void> {
    return this.work(resource);
  }
  retainAlias(url: string): void { this.retainRedirectAlias(url); }
}

const resource = (name: string) => createResource({type: ResourceType.Binary,
  depth: 0, url: 'https://example.test/' + name, refUrl: 'https://example.test/', localRoot: 'output', keepSearch: true});

describe('redirect reservations', () => {
  test.each([false, true])('a successful alias survives a concurrent failure (throw=%s)', async throws => {
    const crawler = new Crawler(false);
    const aliased = Promise.withResolvers<void>();
    try {
      await crawler._initOptions;
      crawler.work = async res => {
        if (res.url.endsWith('/source')) {
          crawler.retainAlias('https://example.test/target#fragment');
          aliased.resolve();
          return;
        }
        await aliased.promise;
        if (throws) throw new Error('target failed');
        return false;
      };
      expect(crawler.addProcessedResource(resource('target'))).toBe(true);
      expect(crawler.addProcessedResource(resource('source'))).toBe(true);
      await crawler.start();
      await crawler.onIdle();
      expect(crawler.addProcessedResource(resource('target#other'))).toBe(false);
      expect(crawler.queuedUrl.has('https://example.test/target')).toBe(true);
      expect(crawler.addProcessedResource(resource('target?different'))).toBe(true);
      await crawler.onIdle();
      // A failed URL without a successful alias can still be explicitly retried.
      expect(crawler.addProcessedResource(resource('target?different'))).toBe(true);
    } finally { await crawler.dispose(); }
  });

  test('redirect aliases use the same query normalization as admission', async () => {
    const crawler = new Crawler(true);
    try {
      await crawler._initOptions;
      crawler.work = async () => crawler.retainAlias('https://example.test/target?a=1#fragment');
      expect(crawler.addProcessedResource(resource('source'))).toBe(true);
      await crawler.start();
      await crawler.onIdle();
      expect(crawler.addProcessedResource(resource('target?b=2#other'))).toBe(false);
      expect(crawler.queuedUrl.has('https://example.test/target')).toBe(true);
    } finally { await crawler.dispose(); }
  });
});
