import {afterAll, beforeAll, describe, expect, test} from '@jest/globals';
import {createServer} from 'node:http';
import type {IncomingHttpHeaders} from 'node:http';
import type {AddressInfo} from 'node:net';
import {getEventListeners, once} from 'node:events';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {gzipSync, deflateSync, brotliCompressSync} from 'node:zlib';
import {canUseNativeHttp, nativeBufferedRequest} from '../../src/life-cycle/native-http.js';
import {downloadNativeResource, downloadResource, downloadResourceDirect,
  getRetry, requestForResource} from '../../src/life-cycle/download-resource.js';
import {
  downloadNativeStreamingResource, downloadStreamingResource, downloadStreamingResourceDirect,
  optionallySetLastModifiedTime, streamingDownloadToFile
} from '../../src/life-cycle/download-streaming-resource.js';
import type {RequestOptions} from '../../src/life-cycle/types.js';
import type {StaticDownloadOptions} from '../../src/options.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {createResource, ResourceType} from '../../src/resource.js';
import {getLogger, setLogger} from '../../src/logger/logger.js';
import type {PipelineExecutor} from '../../src/life-cycle/pipeline-executor.js';

const payload = Buffer.from(Array.from({length: 64 * 1024}, (_, index) => index % 251));
const prefixBytes = 16 * 1024;
const encoded = {gzip: gzipSync(payload), deflate: deflateSync(payload), br: brotliCompressSync(payload)};
const seen = new Map<string, IncomingHttpHeaders[]>();
const outputs = new Map<string, string>();
const fixtureErrors: unknown[] = [];
let origin: string;
let root: string;
const previousLogger = getLogger();

async function waitForPrefix(file: string, size: number): Promise<void> {
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    try {
      if ((await fs.stat(file)).size >= size) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(2);
  }
  throw new Error(`Range fixture did not persist ${size} bytes before interruption`);
}

const server = createServer((request, response) => {
  const url = new URL(request.url!, 'http://fixture');
  const key = url.pathname + url.search;
  const requests = [...seen.get(key) ?? [], request.headers];
  seen.set(key, requests);
  const group = url.pathname.split('/')[1];
  if (group === 'status') {
    if (requests.length <= Number(url.searchParams.get('fail') ?? 1)) {
      response.statusCode = Number(url.searchParams.get('code') ?? 503);
      const after = url.searchParams.get('after');
      if (after !== null) response.setHeader('Retry-After', after);
      response.end('unavailable');
    } else response.end(payload);
  } else if (group === 'reset') {
    if (requests.length === 1) request.socket.destroy();
    else response.end(payload);
  } else if (group === 'slow') {
    response.writeHead(200);
    response.flushHeaders();
  } else if (group === 'empty') {
    response.statusCode = Number(url.searchParams.get('code') ?? 200);
    response.end();
  } else if (group === 'redirect') {
    response.writeHead(302, {location: '/gzip/' + url.pathname.split('/')[2]});
    response.end();
  } else if (group === 'loop') {
    response.writeHead(302, {location: key});
    response.end();
  } else if (group === 'range') {
    const mode = url.searchParams.get('mode');
    response.setHeader('Accept-Ranges', 'bytes');
    let start = Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
    if (mode === 'restart') start = 0;
    if (mode === 'wrong' && start) start++;
    if (start) {
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${payload.length - 1}/${payload.length}`);
    }
    response.setHeader('Content-Length', payload.length - start);
    if (requests.length === 1 || mode === 'always') {
      response.write(payload.subarray(start, start + prefixBytes));
      // A fixed sleep can expire before a slow filesystem opens the output.
      // Interrupt only after the intended prefix exists, so recovery must send
      // an actual Range request; record a fixture failure if that never happens.
      void waitForPrefix(outputs.get(key)!, start + prefixBytes).then(() => response.destroy(), error => {
        fixtureErrors.push(error);
        response.destroy();
      });
    } else response.end(payload.subarray(start));
  } else if (group === 'gzip' || group === 'deflate' || group === 'br') {
    response.setHeader('Content-Encoding', group);
    response.end(encoded[group]);
  } else response.end(payload);
});

beforeAll(async () => {
  root = await fs.mkdtemp(join(process.cwd(), '.wse-native-http-'));
  setLogger({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(root, {recursive: true, force: true});
  setLogger(previousLogger);
  expect(fixtureErrors).toEqual([]);
});

function config(overrides: RequestOptions = {}): RequestOptions {
  return {timeout: {request: 2000}, retry: {limit: 1, backoffLimit: 1, noise: 0},
    responseType: 'buffer', ...overrides};
}

function resource(path: string, streaming = false) {
  const savePath = path.slice(1).replace(/[/?=&]/g, '-');
  outputs.set(path, join(root, savePath));
  return {...createResource({type: streaming ? ResourceType.StreamingBinary : ResourceType.Binary,
    depth: 0, url: origin + path, refUrl: origin + path, localRoot: root,
    savePath
  }), downloadStartTimestamp: Date.now()};
}

test('native is opt-in and unsupported settings fall back before sending', () => {
  const defaults = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root, httpTransport: 'native'});
  expect(canUseNativeHttp(defaults.req)).toBe(true);
  expect(canUseNativeHttp(config())).toBe(true);
  for (const options of [
    {retry: {limit: 1, calculateDelay: () => 1}}, {timeout: {connect: 20}},
    {hooks: {beforeRequest: [() => {}]}}, {https: {rejectUnauthorized: false}},
    {method: 'POST'}, {searchParams: {a: 'b'}}, {responseType: 'json'},
    {cookieJar: {}}, {cache: new Map()}, {http2: true}
  ]) expect(canUseNativeHttp({...config(), ...options} as RequestOptions)).toBe(false);
});

test('initialization specializes built-in downloaders while preserving custom hooks', () => {
  const custom = () => undefined;
  const defaults = defaultLifeCycle();
  const gotOptions = defaultDownloadOptions({...defaults, localRoot: root});
  expect(gotOptions.download).toEqual([
    downloadResourceDirect, downloadStreamingResourceDirect, ...defaults.download.slice(2)
  ]);
  expect(defaults.download.slice(0, 2)).toEqual([downloadResource, downloadStreamingResource]);
  const nativeOptions = defaultDownloadOptions({...defaults, localRoot: root, httpTransport: 'native',
    download: [custom, downloadResource, downloadStreamingResource]});
  expect(nativeOptions.download).toEqual([custom, downloadNativeResource, downloadNativeStreamingResource]);
});

test('streaming last-modified metadata accepts the Unix epoch', async () => {
  const res = resource('/body/epoch-mtime', true);
  await fs.writeFile(join(root, res.savePath), 'epoch');
  res.meta.headers = {'last-modified': 'Thu, 01 Jan 1970 00:00:00 GMT'};
  await optionallySetLastModifiedTime(res, {preferRemoteLastModifiedTime: true} as StaticDownloadOptions);
  expect((await fs.stat(join(root, res.savePath))).mtimeMs).toBe(0);
});

test.each(['got', 'native'] as const)('%s initialized handlers do not re-read transport selection per resource',
  async transport => {
    const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root, httpTransport: transport,
      req: config()});
    Object.defineProperty(options, 'httpTransport', {get() { throw new Error('Transport was read after initialization'); }});
    const buffered = resource(`/body/initialized-${transport}`);
    const downloaded = await options.download[0](buffered, options.req, options, {} as PipelineExecutor);
    if (!downloaded || downloaded === true) throw new Error('Expected a buffered download');
    expect(downloaded.body).toEqual(payload);
    const streamed = resource(`/body/initialized-stream-${transport}`, true);
    await options.download[1](streamed, options.req, options, {} as PipelineExecutor);
    expect(await fs.readFile(join(root, streamed.savePath))).toEqual(payload);
    expect(buffered.meta.httpTransport).toBe(transport === 'native' ? 'native' : undefined);
    expect(streamed.meta.httpTransport).toBe(transport === 'native' ? 'native' : undefined);
  });

describe.each(['got', 'native'] as const)('%s transport parity', transport => {
  const buffered = (path: string, options: RequestOptions = config()) => transport === 'native' ?
    nativeBufferedRequest(origin + path, options) : getRetry(origin + path, options);
  const stream = (path: string, options: RequestOptions = config()) => {
    const res = resource(path, true);
    return {res, pending: streamingDownloadToFile(res, options, {httpTransport: transport} as StaticDownloadOptions)};
  };

  test.each(['body', 'gzip', 'deflate', 'br', 'redirect'])('decodes %s into the same Buffer bytes', async kind => {
    const response = await buffered('/' + kind + '/' + transport);
    expect(Buffer.isBuffer(response?.body)).toBe(true);
    expect(response?.body).toEqual(payload);
  });

  test.each([{method: 'GET', code: 200}, {method: 'GET', code: 204}, {method: 'HEAD', code: 200}] as const)(
    'accepts empty $method $code once', async ({method, code}) => {
      const path = `/empty/${transport}-${method}?code=${code}`;
      const response = await buffered(path, config({method}));
      expect(response?.body).toEqual(Buffer.alloc(0));
      expect(seen.get(path)).toHaveLength(1);
    });

  test.each([
    {name: 'limit-zero', retry: {limit: 0}, count: 1},
    {name: 'limit-two', retry: {limit: 2}, count: 3},
    {name: 'method-filter', retry: {methods: ['HEAD']}, count: 1},
    {name: 'status-filter', retry: {statusCodes: [502]}, count: 1},
    {name: 'status-error-code', retry: {statusCodes: [], errorCodes: ['ERR_NON_2XX_3XX_RESPONSE']}, count: 2},
    {name: 'zero-computed-delay', retry: {backoffLimit: 0}, count: 1}
  ] satisfies Array<{name: string; retry: NonNullable<RequestOptions['retry']>; count: number}>)(
    'honors $name', async ({name, retry, count}) => {
      const path = `/status/${transport}-${name}?fail=99`;
      await expect(buffered(path, config({retry: {limit: 1, backoffLimit: 1, noise: 0, ...retry}})))
        .rejects.toMatchObject({response: {statusCode: 503, retryCount: count - 1}});
      expect(seen.get(path)).toHaveLength(count);
    });

  test.each([
    {name: 'seconds', after: '0.001', count: 2},
    {name: 'past-date', after: 'Thu, 01 Jan 1970 00:00:00 GMT', count: 2},
    {name: 'zero', after: '0', count: 2},
    {name: 'invalid', after: 'invalid', count: 2},
    {name: 'too-long', after: '60', count: 1}
  ])('honors Retry-After $name', async ({name, after, count}) => {
    const path = `/status/${transport}-after-${name}?after=${encodeURIComponent(after)}`;
    const pending = buffered(path, config({retry: {limit: 1, backoffLimit: 1, noise: 0, maxRetryAfter: 20}}));
    if (count === 1) await expect(pending).rejects.toMatchObject({response: {statusCode: 503}});
    else expect((await pending)?.body).toEqual(payload);
    expect(seen.get(path)).toHaveLength(count);
  });

  test.each([false, true])('413 requires Retry-After (%s)', async withRetryAfter => {
    const path = `/status/${transport}-413-${withRetryAfter}?code=413${withRetryAfter ? '&after=0.001' : ''}`;
    const pending = buffered(path);
    if (withRetryAfter) expect((await pending)?.body).toEqual(payload);
    else await expect(pending).rejects.toMatchObject({response: {statusCode: 413}});
    expect(seen.get(path)).toHaveLength(withRetryAfter ? 2 : 1);
  });

  test.each([false, true])('filters transport errors (%s)', async retryable => {
    const path = `/reset/${transport}-${retryable}`;
    const pending = buffered(path, config({retry: {limit: 1, backoffLimit: 1, noise: 0,
      errorCodes: retryable ? ['ECONNRESET'] : []}}));
    if (retryable) expect((await pending)?.body).toEqual(payload);
    else await expect(pending).rejects.toMatchObject({code: 'ECONNRESET'});
    expect(seen.get(path)).toHaveLength(retryable ? 2 : 1);
  });

  test('disabled HTTP errors retain buffered retries and streaming no-retry behavior', async () => {
    const bufferedPath = `/status/${transport}-false-buffer?fail=99`;
    const options = config({throwHttpErrors: false});
    const response = await buffered(bufferedPath, options);
    expect(response?.statusCode).toBe(503);
    expect(response?.body).toEqual(Buffer.from('unavailable'));
    expect(seen.get(bufferedPath)).toHaveLength(2);
    const streamPath = `/status/${transport}-false-stream?fail=99`;
    const {res, pending} = stream(streamPath, options);
    expect((await pending)?.statusCode).toBe(503);
    expect(seen.get(streamPath)).toHaveLength(1);
    expect(await fs.readFile(join(root, res.savePath), 'utf8')).toBe('unavailable');
  });

  test.each(['resume', 'restart'])('recovers an interrupted direct stream: %s', async mode => {
    const path = `/range/${transport}-${mode}?mode=${mode}`;
    const headers = Object.freeze({'x-test': 'original'});
    const {res, pending} = stream(path, config({headers, retry: {limit: 1, backoffLimit: 1, noise: 0,
      errorCodes: ['ECONNRESET', 'ERR_HTTP_CONTENT_LENGTH_MISMATCH', 'ERR_STREAM_PREMATURE_CLOSE']}}));
    expect((await pending)?.retryCount).toBe(1);
    expect(seen.get(path)).toHaveLength(2);
    expect(seen.get(path)![1].range).toBe(`bytes=${prefixBytes}-`);
    expect(headers).toEqual({'x-test': 'original'});
    expect(await fs.readFile(join(root, res.savePath))).toEqual(payload);
  });

  test('rejects a misaligned resumed range instead of accepting incomplete output', async () => {
    const path = `/range/${transport}-wrong?mode=wrong`;
    const {res, pending} = stream(path, config({retry: {limit: 1, backoffLimit: 1, noise: 0,
      errorCodes: ['ECONNRESET', 'ERR_HTTP_CONTENT_LENGTH_MISMATCH', 'ERR_STREAM_PREMATURE_CLOSE']}}));
    await expect(pending).rejects.toMatchObject({code: 'ERR_INVALID_RESPONSE_RANGE'});
    expect(seen.get(path)).toHaveLength(2);
    expect(await fs.readFile(join(root, res.savePath))).toEqual(payload.subarray(0, prefixBytes));
  });

  test('exhausted interrupted streams stay within the configured retry limit', async () => {
    const path = `/range/${transport}-exhausted?mode=always`;
    const {pending} = stream(path, config({retry: {limit: 1, backoffLimit: 1, noise: 0,
      errorCodes: ['ECONNRESET', 'ERR_HTTP_CONTENT_LENGTH_MISMATCH', 'ERR_STREAM_PREMATURE_CLOSE']}}));
    await expect(pending).rejects.toMatchObject({
      code: expect.stringMatching(/^(ECONNRESET|ERR_HTTP_CONTENT_LENGTH_MISMATCH|ERR_STREAM_PREMATURE_CLOSE)$/)
    });
    expect(seen.get(path)).toHaveLength(2);
  });

  test('304 preserves cached direct output and releases the signal listener', async () => {
    const path = `/empty/${transport}-cached?code=304`;
    const res = resource(path, true);
    await fs.writeFile(join(root, res.savePath), 'cached');
    const controller = new AbortController();
    const response = await streamingDownloadToFile(res, config({signal: controller.signal}),
      {httpTransport: transport} as StaticDownloadOptions);
    expect(response?.statusCode).toBe(304);
    expect(await fs.readFile(join(root, res.savePath), 'utf8')).toBe('cached');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('completed streams release all request abort listeners', async () => {
    const controller = new AbortController();
    for (let index = 0; index < 6; index++) {
      const {pending} = stream(`/body/${transport}-signal-${index}`, config({signal: controller.signal}));
      await pending;
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
  });

  test('request deadlines and cancellation stop a stalled body', async () => {
    const deadlinePath = '/slow/' + transport + '-deadline';
    await expect(buffered(deadlinePath, config({timeout: {request: 25}, retry: {limit: 0}})))
      .rejects.toMatchObject({code: 'ETIMEDOUT'});
    const controller = new AbortController();
    const arrived = once(server, 'request');
    const pending = buffered('/slow/' + transport + '-abort', config({signal: controller.signal}));
    await arrived;
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('a zero request deadline is enforced', async () => {
    await expect(buffered('/slow/' + transport + '-zero-deadline',
      config({timeout: {request: 0}, retry: {limit: 0}}))).rejects.toMatchObject({code: 'ETIMEDOUT'});
  });

  test('cancellation stops a direct stream after response headers', async () => {
    const path = '/slow/' + transport + '-stream-abort';
    const controller = new AbortController();
    const arrived = once(server, 'request');
    const {pending} = stream(path, config({signal: controller.signal}));
    await arrived;
    await delay(10);
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(seen.get(path)).toHaveLength(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('destination failures reject without transport retries', async () => {
    const path = '/body/' + transport + '-write-failure';
    const res = resource(path, true);
    await fs.mkdir(join(root, res.savePath));
    await expect(streamingDownloadToFile(res, config(), {httpTransport: transport} as StaticDownloadOptions))
      // WSL's Windows filesystem reports EINVAL for this directory-open error.
      .rejects.toMatchObject({code: expect.stringMatching(/^(EISDIR|EINVAL)$/)});
    expect(seen.get(path)).toHaveLength(1);
  });

  test('cancellation interrupts retry backoff without another request', async () => {
    const path = `/status/${transport}-cancel-backoff?fail=99&after=1`;
    const controller = new AbortController();
    const arrived = once(server, 'request');
    const pending = buffered(path, config({signal: controller.signal}));
    await arrived;
    await delay(20);
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(seen.get(path)).toHaveLength(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('redirect limits reject loops', async () => {
    const path = '/loop/' + transport;
    await expect(buffered(path, config({maxRedirects: 1, retry: {limit: 0}}))).rejects.toBeInstanceOf(Error);
    expect(seen.get(path)).toHaveLength(2);
  });
});

test('Got-specific hooks execute through fallback when native was selected', async () => {
  const path = '/body/fallback-hook';
  const res = resource(path);
  const options = config({hooks: {beforeRequest: [request => { request.headers['x-hook'] = 'ran'; }]}});
  const result = await requestForResource(res, options, {httpTransport: 'native'} as StaticDownloadOptions);
  expect(result?.body).toEqual(payload);
  expect(res.meta.httpTransport).toBe('got');
  expect(seen.get(path)![0]['x-hook']).toBe('ran');
});
