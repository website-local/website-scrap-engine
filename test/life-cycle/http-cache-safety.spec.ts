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
import {getRetry} from '../../src/life-cycle/download-resource.js';
import {streamingDownloadToFile} from '../../src/life-cycle/download-streaming-resource.js';
import {createResource, ResourceType} from '../../src/resource.js';

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

describe.each(['buffered', 'streaming'] as const)('%s HTTP cache safety', mode => {
  async function download(route: string, options: OptionsInit) {
    const requestOptions = {retry: {limit: 0}, timeout: {request: 2000}, ...options};
    const url = origin + route;
    if (mode === 'buffered') {
      const response = await getRetry(url, requestOptions);
      return {body: response?.body?.toString(), headers: response?.headers};
    }
    const resource = {...createResource({type: ResourceType.StreamingBinary,
      depth: 0, url, refUrl: url, localRoot: root, savePath: 'download'}),
    downloadStartTimestamp: Date.now()};
    const response = await streamingDownloadToFile(resource, requestOptions);
    return {body: await fs.readFile(path.join(root, 'download'), 'utf8'),
      headers: response?.headers};
  }

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
