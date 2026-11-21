import {expect, test} from '@jest/globals';
import {disposeHtmlResource} from '../../src/cheerio.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {processRedirectedUrl} from '../../src/life-cycle/adapters.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

const parent = () => createResource({type: ResourceType.Css, depth: 0,
  url: 'https://example.test/docs/style.css', refUrl: 'https://example.test/', localRoot: 'output'});

test('mixed synchronous and asynchronous redirect hooks preserve order and short-circuit', async () => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const events: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  options.linkRedirect = [
    url => { events.push('first'); return url + '/first'; },
    async url => { events.push('waiting'); await waiting; return url + '/second'; },
    url => { events.push(url); return undefined; },
    () => { throw new Error('must not execute'); }
  ];
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const result = pipeline.linkRedirect('https://example.org', null, null);
  expect(events).toEqual(['first', 'waiting']);
  release();
  expect(await result).toBeUndefined();
  expect(events).toEqual(['first', 'waiting', 'https://example.org/first/second']);
  options.linkRedirect = [url => url + '/sync'];
  expect(pipeline.linkRedirect('https://example.org', null, null)).toBe('https://example.org/sync');
});

test.each([
  [undefined, 3], [null, 3], [0, 0]
] as const)('combined link processing preserves explicit or omitted depth %s', async (depth, expected) => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const result = pipeline.createAndProcessResource('../asset.png', ResourceType.Binary,
    depth, null, {...parent(), depth: 2});
  expect(result).toBeInstanceOf(Promise);
  const child = await result;
  expect(child?.depth).toBe(expected);
  expect(child?.url).toBe('https://example.test/asset.png');
});

test('root redirects retain depth zero when creating their canonical resource', async () => {
  const depths: number[] = [];
  const options = defaultDownloadOptions({...defaultLifeCycle(),
    processBeforeDownload: [resource => { depths.push(resource.depth); return resource; }]
  });
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const resource = {...parent(), body: '', redirectedUrl: 'https://example.test/final.css'};
  await processRedirectedUrl(resource, () => {}, options, pipeline);
  expect(depths).toEqual([0]);
  expect(resource.redirectedSavePath).toBe('example.test/final.css');
});

test('combined link processing preserves mixed hook transformations and order', async () => {
  const events: string[] = [];
  const options = defaultDownloadOptions({...defaultLifeCycle(),
    linkRedirect: [url => { events.push('redirect'); return url + '?q=1'; }],
    detectResourceType: [async (_url, type) => { events.push('detect'); return type; }],
    processBeforeDownload: [resource => { events.push('before'); return resource; },
      async resource => { events.push('async-before'); resource.meta.checked = true; return resource; }]
  });
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const result = await pipeline.createAndProcessResource('../asset.png', ResourceType.Binary, 1, null, parent());
  expect(result?.meta.checked).toBe(true);
  expect(result?.downloadLink).toBe('https://example.test/asset.png?q=1');
  expect(events).toEqual(['redirect', 'detect', 'before', 'async-before']);
});

test('SVG links preserve asynchronous hooks and leave discarded links unchanged', async () => {
  const options = defaultDownloadOptions({...defaultLifeCycle(),
    linkRedirect: [async url => url === 'skip.png' ? undefined : url],
    detectResourceType: [async (_url, type) => type],
    processBeforeDownload: [async resource => {
      resource.replacePath = 'saved/' + resource.rawUrl;
      return resource;
    }]
  });
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const resource = {...parent(), type: ResourceType.Svg as const,
    body: '<svg xmlns="http://www.w3.org/2000/svg"><image href="a.png"/>' +
      '<image href="skip.png"/><image href="b.png"/></svg>'};
  const submitted: Resource[] = [];
  try {
    const result = await pipeline.processAfterDownload(resource, value => {
      submitted.push(...Array.isArray(value) ? value : [value]);
    });
    expect(submitted.map(value => value.rawUrl)).toEqual(['a.png', 'b.png']);
    expect(result?.body).toContain('href="saved/a.png"');
    expect(result?.body).toContain('href="skip.png"');
    expect(result?.body).toContain('href="saved/b.png"');
  } finally {
    await disposeHtmlResource(resource);
  }
});

test('synchronous and empty status listeners preserve their Promise API without pending state', async () => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const events: string[] = [];
  options.statusChange = [() => { events.push('first'); }, () => { events.push('second'); }];
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const resource = parent();
  const pending = pipeline.notifyStatusChange(resource, 'dispose');
  expect(pending).toBeInstanceOf(Promise);
  expect(events).toEqual(['first', 'second']);
  expect(resource.meta.statusChanges).toBeUndefined();
  await expect(pending).resolves.toBeUndefined();
  options.statusChange = [];
  await expect(pipeline.notifyStatusChange(resource, 'dispose')).resolves.toBeUndefined();
});

test('status listeners start together and await all settlements despite failures', async () => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const events: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  options.statusChange = [
    () => { events.push('sync'); throw new Error('synchronous failure'); },
    async () => { events.push('waiting'); await waiting; events.push('rejected'); throw new Error('async failure'); },
    () => { events.push('after async'); },
    async () => { await Promise.resolve(); events.push('last async'); },
    () => { events.push('last sync'); }
  ];
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const resource = parent();
  const pending = pipeline.notifyStatusChange(resource, 'error');
  let settled = false;
  void pending.then(() => { settled = true; });
  expect(events).toEqual(['sync', 'waiting', 'after async', 'last sync']);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(events).toEqual(['sync', 'waiting', 'after async', 'last sync', 'last async']);
  expect(settled).toBe(false);
  release();
  await expect(pending).resolves.toBeUndefined();
  expect(events).toEqual(['sync', 'waiting', 'after async', 'last sync', 'last async', 'rejected']);
  await disposeHtmlResource(resource);
  expect(resource.meta.statusChanges).toBeUndefined();
});

test('status listeners retain standalone receivers across asynchronous boundaries', async () => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const receivers: unknown[] = [];
  options.statusChange = [
    function (this: unknown) { receivers.push(this); },
    async function (this: unknown) { await Promise.resolve(); receivers.push(this); },
    function (this: unknown) { receivers.push(this); }
  ];
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  await pipeline.notifyStatusChange(parent(), 'dispose');
  expect(receivers).toEqual([undefined, undefined, undefined]);
});
