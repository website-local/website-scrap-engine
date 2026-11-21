import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import got from 'got';
import type {OptionsInit} from 'got';
import {downloadResource, downloadResourceDirect, getRetry} from '../../src/life-cycle/download-resource.js';
import {downloadStreamingResource, downloadStreamingResourceDirect,
  streamingDownloadToFile} from '../../src/life-cycle/download-streaming-resource.js';
import {readOrCopyLocalResource} from '../../src/life-cycle/read-or-copy-local-resource.js';
import {createResource, ResourceType} from '../../src/resource.js';
import {defaultDownloadOptions, mergeOverrideOptions, selectDownloadHandlers} from '../../src/options.js';
import type {DownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {beforeRetryHook, withHttpCacheSafety} from '../../src/life-cycle/retry-hook.js';

let server: Server;
let root: string;
let origin: string;
let requests: string[];
let cache: Map<string, string>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'wse-cache-safety-'));
  requests = [];
  cache = new Map();
  server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === '/redirect') {
      response.writeHead(302, {location: '/private', 'cache-control': 'no-store'});
      response.end();
    } else if (request.url === '/retry') {
      response.writeHead(503, {'cache-control': 'no-store'});
      response.end('retry');
    } else if (request.url === '/public') {
      response.writeHead(200, {'cache-control': 'public, max-age=3600'});
      response.end('public content');
    } else {
      const user = request.headers.cookie === 'user=alice' ? 'alice' : 'anonymous';
      response.writeHead(200, {'cache-control': 'max-age=3600',
        'set-cookie': 'session=' + user});
      response.end(user);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(root, {recursive: true, force: true});
});

async function primeCache(route = '/private'): Promise<void> {
  // A shared adapter may already contain entries written by another Got caller.
  await got(origin + route, {cache, headers: {cookie: 'user=alice'},
    retry: {limit: 0}, timeout: {request: 2000}});
  for (let attempt = 0; attempt < 20 && cache.size === 0; attempt++) await delay(5);
  expect(cache.size).toBe(1);
}

const guardedDownloadHooks = [downloadResource, downloadStreamingResource, readOrCopyLocalResource];
const directDownloadHooks = [downloadResourceDirect, downloadStreamingResourceDirect, readOrCopyLocalResource];

test('selects direct handlers for standard uncached options without changing the public lifecycle', () => {
  const lifeCycle = defaultLifeCycle();
  const config = defaultDownloadOptions({...lifeCycle, localRoot: root});
  expect(config.download).toEqual(directDownloadHooks);
  expect(defaultDownloadOptions(config).download).toEqual(directDownloadHooks);
  expect(lifeCycle.download).toEqual(guardedDownloadHooks);
});

test.each([
  ['cache', () => ({req: {cache}})],
  ['Got init', () => ({req: {hooks: {init: [() => {}]}}})],
  ['Got beforeRequest', () => ({req: {hooks: {beforeRequest: [() => {}]}}})],
  ['Got beforeRedirect', () => ({req: {hooks: {beforeRedirect: [() => {}]}}})],
  ['Got afterResponse', () => ({req: {hooks: {afterResponse: [response => response]}}})],
  ['Got beforeRetry', () => ({req: {hooks: {beforeRetry: [beforeRetryHook, () => {}]}}})]
] satisfies Array<[string, () => Partial<DownloadOptions>]>)('keeps guarded handlers with %s configured',
  (_name, overrides) => {
    const config = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root, ...overrides()});
    expect(config.download).toEqual(guardedDownloadHooks);
  });

function unexpectedCallback(): never {
  throw new Error('Handler selection must not execute configured lifecycle callbacks');
}

test.each([
  ['init', {init: [unexpectedCallback]}],
  ['processBeforeDownload', {processBeforeDownload: [unexpectedCallback]}],
  ['dispose', {dispose: [unexpectedCallback]}],
  ['linkRedirect', {linkRedirect: [unexpectedCallback]}],
  ['detectResourceType', {detectResourceType: [unexpectedCallback]}],
  ['download', {download: [...guardedDownloadHooks, unexpectedCallback]}],
  ['processAfterDownload', {processAfterDownload: [...defaultLifeCycle().processAfterDownload, unexpectedCallback]}],
  ['saveToDisk', {saveToDisk: [...defaultLifeCycle().saveToDisk, unexpectedCallback]}],
  ['statusChange', {statusChange: [unexpectedCallback]}],
  ['createResource', {createResource: unexpectedCallback}],
  ['generateSavePath', {generateSavePath: unexpectedCallback}],
  ['loadHtml', {loadHtml: unexpectedCallback}],
  ['createLogger', {createLogger: unexpectedCallback}],
  ['adjustConcurrencyFunc', {adjustConcurrencyFunc: unexpectedCallback}]
] satisfies Array<[string, Partial<DownloadOptions>]>)('keeps uncached handlers direct with a custom %s callback',
  (_name, overrides) => {
    const config = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root, ...overrides});
    expect(config.req.cache).toBeUndefined();
    expect(config.download.slice(0, 3)).toEqual(directDownloadHooks);
  });

test('reordered, duplicate and subset builtins remain direct without mutating frozen caller arrays', () => {
  const lifeCycle = defaultLifeCycle();
  lifeCycle.download = [readOrCopyLocalResource, downloadStreamingResource, downloadResource, downloadResource];
  lifeCycle.processAfterDownload = [lifeCycle.processAfterDownload[5], lifeCycle.processAfterDownload[0],
    lifeCycle.processAfterDownload[5]];
  Object.freeze(lifeCycle.download);
  Object.freeze(lifeCycle.processAfterDownload);
  const config = defaultDownloadOptions({...lifeCycle, localRoot: root});
  expect(config.download).toEqual([readOrCopyLocalResource, downloadStreamingResourceDirect,
    downloadResourceDirect, downloadResourceDirect]);
  expect(lifeCycle.download[1]).toBe(downloadStreamingResource);
  expect(lifeCycle.download[2]).toBe(downloadResource);
});

test('reselects both HTTP handlers when later merges enable, disable and reenable caching', () => {
  const uncached = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root});
  const cached = mergeOverrideOptions(uncached, {req: {cache}});
  const disabled = mergeOverrideOptions(cached, {req: {cache: false}});
  const enabledAgain = mergeOverrideOptions(disabled, {req: {cache}});

  expect(uncached.download).toEqual(directDownloadHooks);
  expect(uncached.req.cache).toBeUndefined();
  expect(cached.download).toEqual(guardedDownloadHooks);
  expect(cached.req.cache).toBe(cache);
  expect(disabled.download).toEqual(directDownloadHooks);
  expect(disabled.req.cache).toBeUndefined();
  expect(enabledAgain.download).toEqual(guardedDownloadHooks);
  expect(enabledAgain.req.cache).toBe(cache);
});

test('preserves custom download handlers and restores direct neighbours after disabling caching', () => {
  const customDownload: DownloadOptions['download'][number] = resource => resource;
  const config = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root, req: {cache},
    download: [downloadResourceDirect, customDownload, downloadStreamingResourceDirect, readOrCopyLocalResource]});
  const disabled = mergeOverrideOptions(config, {req: {cache: false}});

  expect(disabled.req.cache).toBeUndefined();
  expect(disabled.download).toEqual([
    downloadResourceDirect, customDownload, downloadStreamingResourceDirect, readOrCopyLocalResource
  ]);
  expect(config.download).toEqual([
    downloadResource, customDownload, downloadStreamingResource, readOrCopyLocalResource
  ]);
});

test('reuses default request options with the retained retry logger and still guards custom retry hooks', () => {
  const config = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root});
  const pipeline = new PipelineExecutorImpl(config, config.req, config);
  expect(pipeline.requestOptions.cache).toBeUndefined();
  expect(pipeline.requestOptions.hooks?.beforeRetry).toEqual([beforeRetryHook]);
  expect(withHttpCacheSafety(pipeline.requestOptions)).toBe(pipeline.requestOptions);

  const custom = {...pipeline.requestOptions, hooks: {...pipeline.requestOptions.hooks,
    beforeRetry: [beforeRetryHook, () => {}]}};
  const originalBeforeRequest = custom.hooks.beforeRequest;
  const guarded = withHttpCacheSafety(custom);
  expect(guarded).not.toBe(custom);
  expect(guarded.hooks).not.toBe(custom.hooks);
  expect(guarded.hooks?.beforeRequest).toHaveLength(1);
  expect(custom.hooks.beforeRequest).toBe(originalBeforeRequest);
  expect(custom.hooks.beforeRequest ?? []).toEqual([]);
});

describe.each(['buffered', 'streaming'] as const)('%s HTTP cache safety', mode => {
  async function download(route: string, options: OptionsInit) {
    const requestOptions = {retry: {limit: 0}, timeout: {request: 2000}, ...options};
    const url = origin + route;
    if (mode === 'buffered') {
      const response = await getRetry(url, requestOptions);
      return {body: response?.body?.toString(), headers: response?.headers};
    }
    const resource = {...createResource({type: ResourceType.StreamingBinary,
      depth: 0, url, refUrl: url, localRoot: root}),
    savePath: 'download', downloadStartTimestamp: Date.now()};
    const response = await streamingDownloadToFile(resource, requestOptions);
    return {body: await fs.readFile(path.join(root, 'download'), 'utf8'),
      headers: response?.headers};
  }

  test.each(['init', 'processBeforeDownload'] as const)(
    'guards private responses when the %s lifecycle enables caching and reselects handlers', async stage => {
      await primeCache();
      const headers = Object.freeze({'Cache-Control': 'max-stale=999999'});
      let hookCalls = 0;
      const enableCache = () => {
        ++hookCalls;
        config.req.cache = cache;
        config.req.headers = headers;
        selectDownloadHandlers(config);
      };
      const lifeCycle = defaultLifeCycle();
      if (stage === 'init') lifeCycle.init.push(enableCache);
      else lifeCycle.processBeforeDownload.push(resource => {
        enableCache();
        return resource;
      });
      const config = defaultDownloadOptions({...lifeCycle, localRoot: root,
        req: {retry: {limit: 0}, timeout: {request: 2000}}});
      expect(config.req.cache).toBeUndefined();
      expect(config.download).toEqual(directDownloadHooks);
      const pipeline = new PipelineExecutorImpl(config, config.req, config);
      await pipeline.init(pipeline);
      expect(config.req.cache).toBe(stage === 'init' ? cache : undefined);

      const url = origin + '/private';
      const resource = {...createResource({
        type: mode === 'buffered' ? ResourceType.Binary : ResourceType.StreamingBinary,
        depth: 0, url, refUrl: url, localRoot: root
      }), savePath: 'lifecycle-download'};
      expect(await pipeline.processBeforeDownload(resource, null, null)).toBe(resource);
      expect(hookCalls).toBe(1);
      expect(config.download).toEqual(guardedDownloadHooks);
      const result = await pipeline.download(resource);
      if (mode === 'buffered') {
        expect(result).toBe(resource);
        expect(resource.body?.toString()).toBe('anonymous');
      } else {
        expect(result).toBe(true);
        expect(await fs.readFile(path.join(root, resource.savePath), 'utf8')).toBe('anonymous');
      }
      expect(resource.meta.headers?.['set-cookie']).toEqual(['session=anonymous']);
      expect(requests).toEqual(['/private', '/private']);
      expect(config.req.cache).toBe(cache);
      expect(config.req.headers).toBe(headers);
    });

  test.each(['max-stale', 'max-age=0, max-stale = "999999"',
    'MAX-STALE=999999'])('does not revive a private cookie response with %s', async header => {
    await primeCache();
    const options = {cache, headers: Object.freeze({'Cache-Control': header})};
    const result = await download('/private', options);
    expect(result.body).toBe('anonymous');
    expect(result.headers?.['set-cookie']).toEqual(['session=anonymous']);
    expect(requests).toEqual(['/private', '/private']);
    expect(options.cache).toBe(cache);
    expect(options.headers).toEqual({'Cache-Control': header});
  });

  test('guards caching enabled by a beforeRequest hook', async () => {
    await primeCache();
    const result = await download('/private', {hooks: {beforeRequest: [options => {
      options.cache = cache;
      options.headers['cache-control'] = ['max-age=0', 'max-stale=999999'];
    }]}});
    expect(result.body).toBe('anonymous');
    expect(requests).toEqual(['/private', '/private']);
  });

  test('guards caching enabled by an init hook', async () => {
    await primeCache();
    const result = await download('/private', {hooks: {init: [options => {
      options.cache = cache;
      options.headers = {'cache-control': 'max-stale=999999'};
    }]}});
    expect(result.body).toBe('anonymous');
    expect(requests).toEqual(['/private', '/private']);
  });

  test('guards caching enabled on a redirect', async () => {
    await primeCache();
    const result = await download('/redirect', {hooks: {beforeRedirect: [options => {
      options.cache = cache;
      options.headers['cache-control'] = 'max-stale=999999';
    }]}});
    expect(result.body).toBe('anonymous');
    expect(requests).toEqual(['/private', '/redirect', '/private']);
  });

  test('retains ordinary public cache hits', async () => {
    await primeCache('/public');
    const result = await download('/public', {cache});
    expect(result.body).toBe('public content');
    expect(requests).toEqual(['/public']);
  });
});

test('guards caching enabled by a retry hook', async () => {
  await primeCache();
  const response = await getRetry(origin + '/retry', {
    timeout: {request: 2000}, retry: {limit: 1, calculateDelay: () => 1},
    hooks: {beforeRetry: [error => {
      error.options.url = new URL(origin + '/private');
      error.options.cache = cache;
      error.options.headers['cache-control'] = 'max-stale=999999';
    }]}
  });
  expect(response?.body).toBe('anonymous');
  expect(requests).toEqual(['/private', '/retry', '/private']);
});

test('guards a cache request retried by an afterResponse hook', async () => {
  await primeCache();
  const response = await getRetry(origin + '/public', {
    timeout: {request: 2000}, retry: {limit: 1},
    hooks: {afterResponse: [(_response, retry) => retry({
      url: origin + '/private', cache,
      headers: {'cache-control': 'max-stale=999999'}
    })]}
  });
  expect(response?.body).toBe('anonymous');
  expect(requests).toEqual(['/private', '/public', '/private']);
});
