import {expect, test} from '@jest/globals';
import {SingleThreadDownloader} from '../../src/downloader/single.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultDownloadOptions} from '../../src/options.js';
import type {DownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {createResource, ResourceType} from '../../src/resource.js';
import {disposeHtmlResource, load, prepareHtmlParser} from '../../src/cheerio.js';
import type {CheerioStatic} from '../../src/types.js';
import {state} from '../grovedom-fixture.js';

const resource = () => createResource({type: ResourceType.Binary, depth: 1,
  url: 'https://example.test/child', refUrl: 'https://example.test/', localRoot: 'output'});
const crawlerWith = (options: Partial<DownloadOptions>) =>
  new SingleThreadDownloader(new URL('./budget-options.js', import.meta.url).href, options);

const parserOptions = {htmlParser: 'grovedom' as const, grovedom: {
  module: new URL('../grovedom-fixture.cjs', import.meta.url).href,
  poolSize: 0, poolMaxBytes: 0
}};

test('synchronous and empty status listeners retain the Promise API', async () => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const events: string[] = [];
  options.statusChange = [() => { events.push('first'); }, () => { events.push('second'); }];
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const res = resource();
  const pending = pipeline.notifyStatusChange(res, 'dispose');
  expect(pending).toBeInstanceOf(Promise);
  expect(events).toEqual(['first', 'second']);
  expect(res.meta.statusChanges).toBeUndefined();
  await expect(pending).resolves.toBeUndefined();
  options.statusChange = [];
  await expect(pipeline.notifyStatusChange(res, 'dispose')).resolves.toBeUndefined();
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
  const res = resource();
  const pending = pipeline.notifyStatusChange(res, 'error');
  expect(events).toEqual(['sync', 'waiting']);
  release();
  await expect(pending).resolves.toBeUndefined();
  expect(events).toEqual(['sync', 'waiting', 'rejected', 'after rejection', 'last async', 'last sync']);
  await disposeHtmlResource(res);
  expect(res.meta.statusChanges).toBeUndefined();
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

test.each(['dispose', 'error'] as const)('disposal waits for %s listeners with an explicit pipeline logger', async status => {
  const events: string[] = [], loggers: unknown[] = [];
  const logger = {trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false};
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const crawler = crawlerWith({maxDepth: 0, createLogger: () => logger, statusChange: [
    async (_res, currentStatus, _options, pipeline) => {
      events.push(currentStatus);
      loggers.push(pipeline.logger);
      await waiting;
      loggers.push(pipeline.logger);
      events.push('settled');
      throw new Error('listener failure is swallowed');
    },
    () => { events.push('following listener'); }
  ]});
  try {
    await crawler.init;
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
    expect(loggers).toEqual([logger, logger]);
    expect(crawler.state).toBe('closed');
  } finally {
    release();
    await crawler.dispose();
  }
});

test.each(['dispose', 'error'] as const)('resource ownership waits for every asynchronous %s listener', async status => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const res = resource();
  const before = state.documents.length;
  const crawler = crawlerWith({...parserOptions, maxDepth: 0, statusChange: [
    async current => {
      events.push('start');
      await gate;
      events.push(current.meta.doc!.html());
      throw new Error('the following listener must still run');
    },
    async (current, _status, options) => {
      await Promise.resolve();
      events.push(current.meta.doc!.html());
      // A listener replacing its document releases the old one directly;
      // resource cleanup waits for this listener itself and runs afterwards.
      (current.meta.doc as CheerioStatic & {dispose(): void}).dispose();
      current.meta.doc = load('<p>status replacement</p>', undefined, undefined, options);
      events.push(current.meta.doc.html());
    }
  ]});
  let pending: Promise<void> | undefined;
  try {
    await crawler.init;
    const document = res.meta.doc = load('<p>retained error document</p>', undefined, undefined, parserOptions);
    if (status === 'dispose') expect(crawler.addProcessedResource(res)).toBe(false);
    else crawler.handleError(new Error('download failed'), 'downloading', res);
    let closed = false;
    pending = crawler.dispose().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(document.html()).toContain('retained error document');
    const independent = resource();
    independent.meta.doc = load('<p>independent</p>', undefined, undefined, parserOptions);
    await disposeHtmlResource(independent);
    expect(independent.meta.doc).toBeUndefined();
    expect(document.html()).toContain('retained error document');
    release();
    await pending;
    expect(events).toEqual(['start', expect.stringContaining('retained error document'),
      expect.stringContaining('retained error document'), expect.stringContaining('status replacement')]);
    expect(res.meta.doc).toBeUndefined();
    expect(res.meta.statusChanges).toBeUndefined();
    expect(state.documents.slice(before).every(doc => doc.closed && doc.disposals === 1)).toBe(true);
  } finally {
    release();
    await pending;
    await crawler.dispose();
  }
});

test('resource cleanup includes same-resource notifications started by a resumed listener', async () => {
  let releaseFirst!: () => void, releaseSecond!: () => void, secondStarted!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const secondReady = new Promise<void>(resolve => { secondStarted = resolve; });
  const res = resource(), events: string[] = [];
  const config = defaultDownloadOptions({...defaultLifeCycle(), ...parserOptions,
    statusChange: [async (current, status, _options, pipeline) => {
      if (status === 'error') {
        await firstGate;
        void pipeline.notifyStatusChange(current, 'dispose');
      } else {
        secondStarted();
        await secondGate;
        events.push(current.meta.doc!.html());
      }
    }]
  });
  const pipeline = new PipelineExecutorImpl(config, config.req, config);
  const document = res.meta.doc = load('<p>nested notification</p>', undefined, undefined, parserOptions);
  void pipeline.notifyStatusChange(res, 'error');
  let closed = false;
  const pending = Promise.resolve(disposeHtmlResource(res)).then(() => { closed = true; });
  try {
    releaseFirst();
    await secondReady;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(document.html()).toContain('nested notification');
    releaseSecond();
    await pending;
    expect(events).toEqual([expect.stringContaining('nested notification')]);
    expect(res.meta.doc).toBeUndefined();
    expect(res.meta.statusChanges).toBeUndefined();
    expect(() => document.html()).toThrow('Disposed');
  } finally {
    releaseFirst();
    releaseSecond();
    await pending;
  }
});

test('downloader cleanup waits for a second resource notified by a resumed listener', async () => {
  let releaseFirst!: () => void, releaseSecond!: () => void, secondStarted!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const secondReady = new Promise<void>(resolve => { secondStarted = resolve; });
  const first = resource(), second = resource();
  second.url += '/second';
  const events: string[] = [];
  const crawler = crawlerWith({...parserOptions, statusChange: [async (current, _status, options) => {
    if (current === first) {
      await firstGate;
      second.meta.doc = load('<p>second notification</p>', undefined, undefined, options);
      crawler.handleError(new Error('second'), 'status callback', second);
    } else {
      secondStarted();
      await secondGate;
      events.push(current.meta.doc!.html());
    }
  }]});
  let pending: Promise<void> | undefined;
  try {
    await crawler.init;
    crawler.handleError(new Error('first'), 'downloading', first);
    let closed = false;
    pending = crawler.dispose().then(() => { closed = true; });
    releaseFirst();
    await secondReady;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(second.meta.doc!.html()).toContain('second notification');
    releaseSecond();
    await pending;
    expect(events).toEqual([expect.stringContaining('second notification')]);
    expect(second.meta.doc).toBeUndefined();
  } finally {
    releaseFirst();
    releaseSecond();
    await pending;
    await crawler.dispose();
  }
});

test.each(['error', 'dispose', 'cancelled child'] as const)(
  '%s notifications can explicitly load the configured parser before processing', async kind => {
    let document: CheerioStatic | undefined;
    const events: string[] = [];
    const res = resource();
    const crawler = crawlerWith({...parserOptions, maxDepth: kind === 'dispose' ? 0 : 1,
      statusChange: [async (current, _status, options) => {
        await Promise.resolve();
        document = current.meta.doc = load('<p>outside resource processing</p>', undefined, undefined, options);
        events.push(document.html());
      }]
    });
    try {
      await crawler.init;
      if (kind === 'cancelled child') expect(crawler.addProcessedResource(res)).toBe(true);
      else if (kind === 'dispose') expect(crawler.addProcessedResource(res)).toBe(false);
      else crawler.handleError(new Error('before processing'), 'admitting resource', res);
      await crawler.dispose();
      expect(events).toEqual([expect.stringContaining('outside resource processing')]);
      expect(res.meta.doc).toBeUndefined();
      expect(() => document!.html()).toThrow('Disposed');
      if (kind === 'cancelled child') expect(crawler.outcomes.get(res.url)?.status).toBe('cancelled');
    } finally { await crawler.dispose(); }
  });

test('parser setup failures in listeners do not escape synchronous error reporting', async () => {
  await prepareHtmlParser(parserOptions);
  const events: string[] = [];
  const crawler = crawlerWith({...parserOptions,
    grovedom: {...parserOptions.grovedom, poolSize: 1}, statusChange: [
      (_res, _status, options) => { load('<p>conflicting parser</p>', undefined, undefined, options); },
      () => { events.push('following listener'); }
    ]});
  const res = resource(), failure = new Error('original failure');
  try {
    await crawler.init;
    expect(() => crawler.handleError(failure, 'admitting resource', res)).not.toThrow();
    expect(events).toEqual(['following listener']);
    expect(res.meta.error).toBe(failure);
    await crawler.dispose();
    expect(crawler.state).toBe('closed');
  } finally { await crawler.dispose(); }
});

test('document disposal failure still waits for other notifications and completes downloader cleanup', async () => {
  const events: string[] = [];
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const first = resource(), second = resource();
  second.url += '/second';
  const before = state.documents.length;
  const crawler = crawlerWith({...parserOptions, statusChange: [async (current, _status, options) => {
    current.meta.doc = load(current === first ? '<p data-dispose-error>first</p>' : '<p>second</p>',
      undefined, undefined, options);
    await (current === first ? firstGate : secondGate);
    events.push(current === first ? 'first notification' : 'second notification');
  }], dispose: [() => { events.push('pipeline cleanup'); }]});
  let pending: Promise<unknown> | undefined;
  let settled = false;
  try {
    await crawler.init;
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
    expect((error as AggregateError).errors).toEqual([expect.objectContaining({message: 'Injected disposal failure'})]);
    expect(events).toEqual(['first notification', 'second notification', 'pipeline cleanup']);
    expect(crawler.state).toBe('closed');
    expect(first.meta.doc).toBeUndefined();
    expect(second.meta.doc).toBeUndefined();
    expect(state.documents.slice(before).every(doc => doc.closed && doc.disposals === 1)).toBe(true);
  } finally {
    releaseFirst();
    releaseSecond();
    await pending;
    await crawler.dispose().catch(() => undefined);
  }
});

test('disposal lifecycle passes stop at the first failure', async () => {
  const events: string[] = [];
  const crawler = crawlerWith({dispose: [
    async () => { events.push('first'); await Promise.resolve(); throw new Error('disposal pass failed'); },
    () => { events.push('dependent pass'); }
  ]});
  await crawler.init;
  await expect(crawler.dispose()).rejects.toMatchObject({
    errors: [expect.objectContaining({message: 'disposal pass failed'})]
  });
  expect(events).toEqual(['first']);
  expect(crawler.state).toBe('closed');
});
