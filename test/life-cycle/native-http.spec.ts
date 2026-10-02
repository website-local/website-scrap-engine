import {afterAll, beforeAll, expect, test} from '@jest/globals';
import {createServer} from 'node:http';
import type {IncomingHttpHeaders} from 'node:http';
import type {AddressInfo} from 'node:net';
import {getEventListeners} from 'node:events';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {gzipSync, deflateSync, brotliCompressSync} from 'node:zlib';
import {canUseNativeHttp, nativeBufferedRequest, NativeHttpError} from '../../src/life-cycle/native-http.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {createResource, ResourceType} from '../../src/resource.js';
import {requestForResource} from '../../src/life-cycle/download-resource.js';
import {streamingDownloadToFile} from '../../src/life-cycle/download-streaming-resource.js';
import {withCrawlContext} from '../../src/crawl-context.js';
import {createDefaultLogger} from '../../src/logger/default-logger.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {BufferBudget} from '../../src/buffer-budget.js';

const payload = Buffer.alloc(32 * 1024, 97);
const seen = new Map<string, IncomingHttpHeaders[]>();
const target = createServer((request, response) => {
  seen.set('/target', [...seen.get('/target') ?? [], request.headers]);
  response.end('target');
});
let targetOrigin: string;
const server = createServer((request, response) => {
  response.setHeader('Connection', 'close');
  const url = request.url!;
  seen.set(url, [...seen.get(url) ?? [], request.headers]);
  if (url.startsWith('/retry-stream-') && (url.endsWith('always') || seen.get(url)!.length === 1)) {
    response.setHeader('Content-Length', payload.length);
    response.write(Buffer.alloc(1024, 98));
    setTimeout(() => response.destroy(), 10);
  } else if (url.startsWith('/retry-native') || url === '/retry-after') {
    if (url === '/retry-after' || url !== '/retry-native-success' || seen.get(url)!.length === 1) {
      response.statusCode = 503;
      if (url === '/retry-after') response.setHeader('Retry-After', '60');
      response.end('unavailable');
    } else response.end(payload);
  } else if (url === '/redirect' || url === '/cross' || url === '/loop') {
    response.statusCode = 302;
    response.setHeader('Location', url === '/cross' ? targetOrigin + '/target' :
      url === '/loop' ? '/loop' : '/gzip');
    response.end();
  } else if (url === '/slow') {
    response.writeHead(200);
    response.flushHeaders();
  } else if (url === '/not-modified') {
    response.statusCode = 304;
    response.end();
  } else if (url === '/empty') {
    response.statusCode = 204;
    response.setHeader('Content-Encoding', 'gzip');
    response.end();
  } else if (url === '/error' || url === '/retry' && seen.get(url)!.length === 1) {
    response.statusCode = 503;
    response.end('unavailable');
  } else {
    if (url === '/gzip') { response.setHeader('Content-Encoding', 'gzip'); response.end(gzipSync(payload)); }
    else if (url === '/deflate') { response.setHeader('Content-Encoding', 'deflate'); response.end(deflateSync(payload)); }
    else if (url === '/br') { response.setHeader('Content-Encoding', 'br'); response.end(brotliCompressSync(payload)); }
    else response.end(payload);
  }
});
let origin: string;
let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(join(process.cwd(), '.wse-native-http-'));
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  targetOrigin = 'http://127.0.0.1:' + (target.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  target.closeAllConnections();
  await Promise.all([new Promise<void>(resolve => server.close(() => resolve())),
    new Promise<void>(resolve => target.close(() => resolve()))]);
  await fs.rm(root, {recursive: true, force: true});
});

const config = () => defaultDownloadOptions({...defaultLifeCycle(), localRoot: root,
  httpTransport: 'native', req: {retry: {limit: 0}}});
const resource = (path: string, streaming = false) => ({...createResource({
  type: streaming ? ResourceType.StreamingBinary : ResourceType.Binary, depth: 0,
  url: origin + path, refUrl: origin + path, localRoot: root, savePath: path.slice(1)
}), downloadStartTimestamp: Date.now()});

test('native defaults are usable; Got-specific options select Got', () => {
  const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root, httpTransport: 'native'});
  expect(options.req.retry?.limit).toBe(2);
  expect(canUseNativeHttp(options.req)).toBe(true);
  expect(canUseNativeHttp({...options.req, retry: {limit: 1}})).toBe(true);
  for (const extra of [{retry: {limit: 1, calculateDelay: () => 1}}, {timeout: {connect: 100}},
    {hooks: {beforeRequest: [() => {}]}}, {https: {rejectUnauthorized: false}},
    {method: 'POST'}, {searchParams: {a: 'b'}}, {decompress: true, responseType: 'json'}] as const) {
    expect(canUseNativeHttp({...options.req, ...extra} as typeof options.req)).toBe(false);
  }
});

test('native status retries honor limits, Retry-After bounds and zero retry', async () => {
  const options = {...config().req, retry: {limit: 2, backoffLimit: 0, noise: 0}};
  const response = await nativeBufferedRequest(origin + '/retry-native-success', options);
  expect(response.body).toEqual(payload);
  expect(response.retryCount).toBe(1);
  await expect(nativeBufferedRequest(origin + '/retry-native-exhausted', options))
    .rejects.toMatchObject({response: {statusCode: 503, retryCount: 2}});
  expect(seen.get('/retry-native-exhausted')).toHaveLength(3);
  await expect(nativeBufferedRequest(origin + '/retry-native-zero', config().req)).rejects.toBeInstanceOf(NativeHttpError);
  expect(seen.get('/retry-native-zero')).toHaveLength(1);
  await expect(nativeBufferedRequest(origin + '/retry-after', {...options,
    retry: {...options.retry, maxRetryAfter: 1}})).rejects.toBeInstanceOf(NativeHttpError);
  expect(seen.get('/retry-after')).toHaveLength(1);
});

test.each([true, false])('native retries restart interrupted output (direct=%s)', async directWrites => {
  const options = config();
  options.req.retry = {limit: 1, backoffLimit: 0, noise: 0};
  const path = '/retry-stream-' + directWrites;
  const res = resource(path, true);
  const context = {directWrites, signal: new AbortController().signal, logger: createDefaultLogger()};
  const response = await withCrawlContext(context, () => streamingDownloadToFile(res, options.req, undefined, options));
  expect(res.meta.httpTransport).toBe('native');
  expect(response?.retryCount).toBe(1);
  expect(seen.get(path)).toHaveLength(2);
  expect(await fs.readFile(join(root, path.slice(1)))).toEqual(payload);
});

test('exhausted native streaming retries preserve cached atomic output', async () => {
  const options = config();
  options.req.retry = {limit: 1, backoffLimit: 0, noise: 0};
  const res = resource('/retry-stream-always', true);
  await fs.writeFile(join(root, res.savePath), 'cached');
  const context = {directWrites: false, signal: new AbortController().signal, logger: createDefaultLogger()};
  await expect(withCrawlContext(context, () => streamingDownloadToFile(res, options.req, undefined, options)))
    .rejects.toMatchObject({code: 'ECONNRESET'});
  expect(seen.get('/retry-stream-always')).toHaveLength(2);
  expect(await fs.readFile(join(root, res.savePath), 'utf8')).toBe('cached');
  expect((await fs.readdir(root)).some(name => name.startsWith('.wse-stage-'))).toBe(false);
});

test('native cancellation interrupts retry backoff without issuing another request', async () => {
  const controller = new AbortController();
  const pending = nativeBufferedRequest(origin + '/retry-native-cancel', {...config().req,
    signal: controller.signal, retry: {limit: 2, noise: 0}});
  const timer = setTimeout(() => controller.abort(), 100);
  try { await expect(pending).rejects.toMatchObject({code: 'ABORT_ERR'}); }
  finally { clearTimeout(timer); }
  expect(seen.get('/retry-native-cancel')).toHaveLength(1);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test.each(['/body', '/gzip', '/deflate', '/br', '/redirect'])('native buffered content matches decoded bytes: %s', async path => {
  const options = config();
  const res = resource(path);
  expect((await requestForResource(res, options.req, options))?.body).toEqual(payload);
  expect(res.meta.httpTransport).toBe('native');
  if (path === '/redirect') expect(res.redirectedUrl).toBe(origin + '/gzip');
});

test('cross-origin redirects remove credentials and cookie headers', async () => {
  await nativeBufferedRequest(origin + '/cross', {...config().req,
    headers: {authorization: 'Bearer private', cookie: 'private=1', cookie2: 'private=2'}});
  expect(seen.get('/target')!.at(-1)).not.toHaveProperty('authorization');
  expect(seen.get('/target')!.at(-1)).not.toHaveProperty('cookie');
  expect(seen.get('/target')!.at(-1)).not.toHaveProperty('cookie2');
});

test('native status errors, redirect bounds and decoded body limits are enforced', async () => {
  await expect(nativeBufferedRequest(origin + '/error', config().req)).rejects.toBeInstanceOf(NativeHttpError);
  await expect(nativeBufferedRequest(origin + '/loop', {...config().req, maxRedirects: 1}))
    .rejects.toMatchObject({code: 'ERR_TOO_MANY_REDIRECTS'});
  await expect(nativeBufferedRequest(origin + '/gzip', config().req, 1024))
    .rejects.toMatchObject({code: 'ERR_RESOURCE_SIZE_LIMIT'});
});

test('HEAD, 204 and disabled HTTP errors preserve their response semantics', async () => {
  expect((await nativeBufferedRequest(origin + '/gzip', {...config().req, method: 'HEAD'})).body.length).toBe(0);
  expect((await nativeBufferedRequest(origin + '/empty', config().req)).body.length).toBe(0);
  expect((await nativeBufferedRequest(origin + '/error', {...config().req, throwHttpErrors: false})).body.toString())
    .toBe('unavailable');
});

test('native buffered acquisition honors the crawl byte budget', async () => {
  const budget = new BufferBudget(1024);
  const reservation = budget.reserve(0);
  const context = {signal: new AbortController().signal, logger: createDefaultLogger(), bufferAccount: reservation};
  try {
    await expect(withCrawlContext(context, () => nativeBufferedRequest(origin + '/gzip', config().req)))
      .rejects.toMatchObject({code: 'ERR_BUFFER_BUDGET'});
  } finally { reservation.release(); }
  expect(budget.used).toBe(0);
});

test('native stream limits preserve cached files in atomic mode', async () => {
  const options = config();
  options.maxResourceBytes = 1024;
  const destination = join(root, 'limited');
  await fs.writeFile(destination, 'cached');
  const res = resource('/gzip', true);
  res.savePath = 'limited';
  const context = {directWrites: false, signal: new AbortController().signal, logger: createDefaultLogger()};
  await expect(withCrawlContext(context, () => streamingDownloadToFile(res,
    options.req, undefined, options))).rejects.toMatchObject({code: 'ERR_RESOURCE_SIZE_LIMIT'});
  expect(await fs.readFile(destination, 'utf8')).toBe('cached');
  expect((await fs.readdir(root)).some(name => name.startsWith('.wse-stage-'))).toBe(false);
});

test('request deadline and cancellation stop a response stalled after headers', async () => {
  await expect(nativeBufferedRequest(origin + '/slow', {...config().req, timeout: {request: 25}}))
    .rejects.toMatchObject({code: 'ETIMEDOUT'});
  const controller = new AbortController();
  const pending = nativeBufferedRequest(origin + '/slow', {...config().req, signal: controller.signal});
  const timer = setTimeout(() => controller.abort(), 25);
  try { await expect(pending).rejects.toMatchObject({code: 'ABORT_ERR'}); }
  finally { clearTimeout(timer); }
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test('unsupported retry and request hooks execute through Got', async () => {
  const options = config();
  options.req.retry = {limit: 1, calculateDelay: () => 1};
  const retried = resource('/retry');
  await requestForResource(retried, options.req, options);
  expect(retried.meta.httpTransport).toBe('got');
  expect(seen.get('/retry')).toHaveLength(2);
  options.req.retry = {limit: 0};
  options.req.hooks = {beforeRequest: [request => { request.headers['x-hook'] = 'ran'; }]};
  const hooked = resource('/hook');
  await requestForResource(hooked, options.req, options);
  expect(hooked.meta.httpTransport).toBe('got');
  expect(seen.get('/hook')!.at(-1)?.['x-hook']).toBe('ran');
});

test('native streams save decoded output and preserve cached output on 304, skip and error', async () => {
  const options = config();
  const context = {directWrites: true, signal: new AbortController().signal, logger: createDefaultLogger()};
  for (const path of ['/gzip', '/not-modified', '/skip', '/error']) {
    const destination = join(root, path.slice(1));
    await fs.writeFile(destination, 'cached');
    options.existingResource = () => path === '/skip' ? 'skip' : 'overwrite';
    const executor = new PipelineExecutorImpl(options, options.req, options);
    const res = resource(path, true);
    const result = withCrawlContext(context, () => streamingDownloadToFile(res,
      {...options.req, signal: context.signal}, executor, options));
    if (path === '/error') await expect(result).rejects.toBeInstanceOf(NativeHttpError);
    else await result;
    expect(await fs.readFile(destination)).toEqual(path === '/gzip' ? payload : Buffer.from('cached'));
    expect(getEventListeners(context.signal, 'abort')).toHaveLength(0);
  }
});
