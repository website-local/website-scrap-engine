import {expect, test} from '@jest/globals';
import {AbstractDownloader} from '../../src/downloader/main.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {currentCrawlContext} from '../../src/crawl-context.js';
import {defaultDownloadOptions} from '../../src/options.js';
import type {DownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {createResource, ResourceType} from '../../src/resource.js';
import {load, prepareHtmlParser, withHtmlParser} from '../../src/cheerio.js';
import type {CheerioStatic} from '../../src/types.js';
import {state} from '../grovedom-fixture.js';

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

const parserOptions = {htmlParser: 'grovedom' as const, grovedom: {
  module: new URL('../grovedom-fixture.cjs', import.meta.url).href,
  poolSize: 0, poolMaxBytes: 0
}};

test.each(['dispose', 'error'] as const)('resource ownership waits for every asynchronous %s listener', async status => {
  const events: string[] = [];
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const res = resource();
  let document!: CheerioStatic;
  const before = state.documents.length;
  const crawler = new Crawler({...parserOptions, maxDepth: 0, statusChange: [
    async current => {
      events.push('start');
      started();
      await gate;
      events.push(current.meta.doc!.html());
      throw new Error('the following listener must still run');
    },
    async current => {
      await Promise.resolve();
      events.push(current.meta.doc!.html());
      current.meta.doc = load('<p>status replacement</p>');
      events.push(current.meta.doc.html());
    }
  ]});
  let pending: Promise<void> | undefined;
  try {
    await crawler._initOptions;
    let closed = false;
    pending = withHtmlParser(parserOptions, async () => {
      await prepareHtmlParser(parserOptions);
      document = res.meta.doc = load('<p>retained error document</p>');
      if (status === 'dispose') expect(crawler.addProcessedResource(res)).toBe(false);
      else crawler.handleError(new Error('download failed'), 'downloading', res);
    }).then(() => { closed = true; });
    await ready;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(document.html()).toContain('retained error document');
    // An unrelated resource must not wait for this resource's status callbacks.
    await withHtmlParser(parserOptions, () => { load('<p>independent</p>'); });
    release();
    await pending;
    expect(events).toEqual(['start', expect.stringContaining('retained error document'),
      expect.stringContaining('retained error document'), expect.stringContaining('status replacement')]);
    expect(res.meta.doc).toBeUndefined();
    expect(state.documents.slice(before).every(doc => doc.closed && doc.disposals === 1)).toBe(true);
  } finally {
    release();
    await pending;
    await crawler.dispose();
  }
});

test('resource ownership includes notifications started by a resumed listener', async () => {
  let releaseFirst!: () => void, releaseSecond!: () => void, secondStarted!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const secondReady = new Promise<void>(resolve => { secondStarted = resolve; });
  const first = resource(), second = resource();
  second.url += '/second';
  const events: string[] = [];
  const crawler = new Crawler({...parserOptions, statusChange: [async current => {
    if (current === first) {
      await firstGate;
      second.meta.doc = load('<p>second notification</p>');
      crawler.handleError(new Error('second'), 'status callback', second);
    } else {
      secondStarted();
      await secondGate;
      events.push(current.meta.doc!.html());
    }
  }]});
  let pending: Promise<void> | undefined;
  try {
    await crawler._initOptions;
    pending = withHtmlParser(parserOptions, async () => {
      await prepareHtmlParser(parserOptions);
      crawler.handleError(new Error('first'), 'downloading', first);
      throw new Error('primary failure');
    });
    const rejected = expect(pending).rejects.toThrow('primary failure');
    releaseFirst();
    await secondReady;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(second.meta.doc!.html()).toContain('second notification');
    releaseSecond();
    await rejected;
    expect(events).toEqual([expect.stringContaining('second notification')]);
    expect(second.meta.doc).toBeUndefined();
  } finally {
    releaseFirst();
    releaseSecond();
    await pending?.catch(() => undefined);
    await crawler.dispose();
  }
});

test.each(['error', 'dispose', 'cancelled child'] as const)(
  '%s notifications outside a live resource scope use the configured parser', async kind => {
    let document: CheerioStatic | undefined;
    const events: string[] = [];
    const res = resource();
    const crawler = new Crawler({...parserOptions, maxDepth: kind === 'dispose' ? 0 : 1,
      statusChange: [async current => {
        await Promise.resolve();
        document = current.meta.doc = load('<p>outside resource processing</p>');
        events.push(document.html());
      }]
    });
    try {
      await crawler._initOptions;
      if (kind === 'cancelled child') {
        await withHtmlParser(parserOptions, () => { expect(crawler.addProcessedResource(res)).toBe(true); });
      } else if (kind === 'dispose') expect(crawler.addProcessedResource(res)).toBe(false);
      else crawler.handleError(new Error('before processing'), 'admitting resource', res);
      await crawler.dispose();
      expect(events).toEqual([expect.stringContaining('outside resource processing')]);
      expect(res.meta.doc).toBeUndefined();
      expect(() => document!.html()).toThrow('Disposed');
      if (kind === 'cancelled child') expect(crawler.outcomes.get(res.url)?.status).toBe('cancelled');
    } finally { await crawler.dispose(); }
  });

test('parser setup failures do not escape synchronous error reporting', async () => {
  await withHtmlParser(parserOptions, () => {});
  const crawler = new Crawler({...parserOptions,
    grovedom: {...parserOptions.grovedom, poolSize: 1}, statusChange: [() => {}]});
  const res = resource();
  const failure = new Error('original failure');
  try {
    await crawler._initOptions;
    expect(() => crawler.handleError(failure, 'admitting resource', res)).not.toThrow();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(res.meta.error).toBe(failure);
    await crawler.dispose();
    expect(crawler.state).toBe('closed');
  } finally { await crawler.dispose(); }
});

test('notification disposal failure still waits for other notifications and completes cleanup', async () => {
  const events: string[] = [];
  class CleanupCrawler extends Crawler {
    protected async disposeResources(): Promise<void> { events.push('resource cleanup'); }
  }
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const first = resource(), second = resource();
  second.url += '/second';
  const before = state.documents.length;
  const crawler = new CleanupCrawler({...parserOptions, statusChange: [async current => {
    current.meta.doc = load(current === first ? '<p data-dispose-error>first</p>' : '<p>second</p>');
    await (current === first ? firstGate : secondGate);
    events.push(current === first ? 'first notification' : 'second notification');
  }], dispose: [() => { events.push('pipeline cleanup'); }]});
  let pending: Promise<unknown> | undefined;
  let settled = false;
  try {
    await crawler._initOptions;
    crawler.handleError(new Error('first failure'), 'admitting resource', first);
    crawler.handleError(new Error('second failure'), 'admitting resource', second);
    pending = crawler.dispose().then(() => { settled = true; }, error => {
      settled = true;
      return error;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseFirst();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(events).toEqual(['first notification']);
    expect(second.meta.doc!.html()).toContain('second');
    releaseSecond();
    const error = await pending;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe('Downloader cleanup failed');
    expect((error as AggregateError).errors).toEqual([expect.objectContaining({message: 'HTML document disposal failed'})]);
    expect(events).toEqual(['first notification', 'second notification', 'resource cleanup', 'pipeline cleanup']);
    expect(crawler.state).toBe('closed');
    expect(first.meta.doc).toBeUndefined();
    expect(second.meta.doc).toBeUndefined();
    expect(state.documents.slice(before).every(doc => doc.closed && doc.disposals === 1)).toBe(true);
  } finally {
    releaseFirst();
    releaseSecond();
    await pending;
    await crawler.dispose().catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
});
