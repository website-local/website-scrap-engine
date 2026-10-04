import {expect, test} from '@jest/globals';
import {AbstractDownloader} from '../../src/downloader/main.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {currentCrawlContext} from '../../src/crawl-context.js';
import {defaultDownloadOptions} from '../../src/options.js';
import type {DownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {createResource, ResourceType} from '../../src/resource.js';

const resource = () => createResource({type: ResourceType.Binary, depth: 1,
  url: 'https://example.test/child', refUrl: 'https://example.test/', localRoot: 'output'});

test('synchronous and empty status listeners retain the Promise API', async () => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const events: string[] = [];
  options.statusChange = [() => { events.push('first'); }, () => { events.push('second'); }];
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const pending = pipeline.notifyStatusChange(resource(), 'dispose');
  expect(pending).toBeInstanceOf(Promise);
  expect(events).toEqual(['first', 'second']);
  await expect(pending).resolves.toBeUndefined();
  options.statusChange = [];
  await expect(pipeline.notifyStatusChange(resource(), 'dispose')).resolves.toBeUndefined();
});

test('status listeners keep their order through synchronous throws and asynchronous rejections', async () => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const events: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  options.statusChange = [
    () => { events.push('sync'); throw new Error('synchronous failure'); },
    async () => { events.push('waiting'); await waiting; events.push('rejected'); throw new Error('async failure'); },
    () => { events.push('after rejection'); },
    async () => { await Promise.resolve(); events.push('last async'); },
    () => { events.push('last sync'); }
  ];
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const pending = pipeline.notifyStatusChange(resource(), 'error');
  expect(events).toEqual(['sync', 'waiting']);
  release();
  await expect(pending).resolves.toBeUndefined();
  expect(events).toEqual(['sync', 'waiting', 'rejected', 'after rejection', 'last async', 'last sync']);
});

test('status listeners retain standalone call receivers across async boundaries', async () => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const receivers: unknown[] = [];
  options.statusChange = [
    function (this: unknown) { receivers.push(this); },
    async function (this: unknown) { await Promise.resolve(); receivers.push(this); },
    function (this: unknown) { receivers.push(this); }
  ];
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  await pipeline.notifyStatusChange(resource(), 'dispose');
  expect(receivers).toEqual([undefined, undefined, undefined]);
});

class Crawler extends AbstractDownloader {
  constructor(options: Partial<DownloadOptions>) {
    super(new URL('./budget-options.js', import.meta.url).href, options);
  }
  async downloadAndProcessResource(): Promise<void> {}
}

test.each(['dispose', 'error'] as const)('disposal waits for pending %s listeners in their crawl context', async status => {
  const events: string[] = [];
  const contexts: unknown[] = [];
  const logger = {trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false};
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const crawler = new Crawler({maxDepth: 0, createLogger: () => logger, statusChange: [
    async (_res, currentStatus) => {
      events.push(currentStatus);
      contexts.push(currentCrawlContext()?.logger);
      await waiting;
      contexts.push(currentCrawlContext()?.logger);
      events.push('settled');
      throw new Error('listener failure is swallowed');
    },
    () => { events.push('following listener'); }
  ]});
  try {
    await crawler._initOptions;
    const res = resource();
    if (status === 'dispose') expect(crawler.addProcessedResource(res)).toBe(false);
    else crawler.handleError(new Error('download failed'), 'downloading', res);
    let closed = false;
    const closing = crawler.dispose().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(events).toEqual([status]);
    expect(closed).toBe(false);
    release();
    await closing;
    expect(events).toEqual([status, 'settled', 'following listener']);
    expect(contexts).toEqual([logger, logger]);
    expect(crawler.state).toBe('closed');
  } finally {
    release();
    await crawler.dispose();
  }
});
