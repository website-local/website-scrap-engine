import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {promises as fs, readFileSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {ResourceType} from '../../src/resource.js';
import {getLogger, setLogger} from '../../src/logger/logger.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {preferNewerRemote} from '../../src/life-cycle/adapters.js';
import type {ExistingResourceFunc} from '../../src/life-cycle/types.js';
import {
  downloadStreamingResourceWithHook
} from '../../src/life-cycle/download-streaming-resource.js';

let root: string;
let server: Server;
const previousLogger = getLogger();

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'wse-conditional-'));
  setLogger({
    trace() {}, debug() {}, info() {}, warn() {}, error() {},
    isTraceEnabled: () => false
  });
});

afterEach(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  await fs.rm(root, {recursive: true, force: true});
  setLogger(previousLogger);
});

const variants = [
  {name: 'HTML', type: ResourceType.Html, hooked: false},
  {name: 'binary', type: ResourceType.Binary, hooked: false},
  {name: 'streaming', type: ResourceType.StreamingBinary, hooked: false},
  {name: 'streaming with hooks', type: ResourceType.StreamingBinary, hooked: true}
];

describe.each(variants)('conditional $name downloads', ({type, hooked}) => {
  test.each([false, true])(
    'preserves cached content on 304 (Last-Modified: %s)',
    async includeLastModified => {
      const cached = Buffer.from('<html><body>cached content</body></html>');
      const mtime = new Date('2024-01-02T03:04:05Z');
      const headers: Array<string | undefined> = [];
      server = createServer((request, response) => {
        response.setHeader('Connection', 'close');
        headers.push(request.headers['if-modified-since']);
        if (includeLastModified) {
          response.setHeader('Last-Modified', mtime.toUTCString());
        }
        response.writeHead(request.headers['if-modified-since'] ? 304 : 200);
        response.end(request.headers['if-modified-since'] ? undefined : cached);
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`;
      const afterDownload = jest.fn<() => void>();
      const downloadError = jest.fn<() => void>();
      const lc = defaultLifeCycle();
      if (hooked) {
        lc.download[1] = downloadStreamingResourceWithHook(
          undefined, afterDownload, downloadError);
      }
      const options = defaultDownloadOptions({
        ...lc,
        localRoot: root,
        existingResource: preferNewerRemote(),
        preferRemoteLastModifiedTime: true,
        req: {retry: {limit: 0}, timeout: {request: 2000}},
        meta: {}
      });
      const pipeline = new PipelineExecutorImpl(options, options.req, options);
      const resource = await pipeline.createResource(type, 0, url, url);
      expect(resource).toBeDefined();
      if (!resource) throw new Error('Resource was discarded');
      const file = path.join(root, resource.savePath);
      await fs.mkdir(path.dirname(file), {recursive: true});
      await fs.writeFile(file, cached);
      await fs.utimes(file, mtime, mtime);
      const originalMtime = (await fs.stat(file)).mtimeMs;

      const downloaded = await pipeline.download(resource);
      if (downloaded && downloaded !== true) {
        const processed = await pipeline.processAfterDownload(downloaded, () => {});
        if (processed) await pipeline.saveToDisk(processed);
      }

      expect(downloaded).toBeUndefined();
      expect(headers).toEqual([mtime.toUTCString()]);
      expect(await fs.readFile(file)).toEqual(cached);
      expect((await fs.stat(file)).mtimeMs).toBe(originalMtime);
      expect(afterDownload).not.toHaveBeenCalled();
      expect(downloadError).not.toHaveBeenCalled();
    }
  );

  test('saves a changed resource returned with 200', async () => {
    const updated = Buffer.from('<html><head></head><body>updated</body></html>');
    const afterDownload = jest.fn<() => void>();
    let requests = 0;
    server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, {
        'Connection': 'close',
        'Last-Modified': 'Wed, 03 Jan 2024 03:04:05 GMT'
      });
      response.end(updated);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`;
    const lc = defaultLifeCycle();
    if (hooked) {
      lc.download[1] = downloadStreamingResourceWithHook(undefined, afterDownload);
    }
    const options = defaultDownloadOptions({
      ...lc,
      localRoot: root,
      existingResource: preferNewerRemote(),
      req: {retry: {limit: 0}, timeout: {request: 2000}},
      meta: {}
    });
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const resource = await pipeline.createResource(type, 0, url, url);
    if (!resource) throw new Error('Resource was discarded');
    const file = path.join(root, resource.savePath);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, 'old content');
    await fs.utimes(file, new Date('2024-01-02'), new Date('2024-01-02'));

    const downloaded = await pipeline.download(resource);
    if (downloaded && downloaded !== true) {
      const processed = await pipeline.processAfterDownload(downloaded, () => {});
      if (processed) await pipeline.saveToDisk(processed);
    }

    expect(requests).toBe(1);
    if (type === ResourceType.StreamingBinary) expect(downloaded).toBe(true);
    expect(await fs.readFile(file)).toEqual(updated);
    expect(afterDownload).toHaveBeenCalledTimes(hooked ? 1 : 0);
  });
});

describe.each([
  {name: 'Got', httpTransport: 'got', hooked: false},
  {name: 'Got with hooks', httpTransport: 'got', hooked: true},
  {name: 'native', httpTransport: 'native', hooked: false},
  {name: 'native with hooks', httpTransport: 'native', hooked: true}
] as const)('streaming $name save policy', ({httpTransport, hooked}) => {
  test.each(['skipSave', 'skip', 'ifModifiedSince'] as const)(
    'checks %s after response metadata without changing cached bytes or mtime', async action => {
      const cached = Buffer.from('cached streaming bytes');
      const remote = Buffer.from('new streaming bytes');
      const cachedMtime = new Date('2024-01-02T03:04:05Z');
      const remoteMtime = action === 'ifModifiedSince' ? cachedMtime : new Date('2024-02-03T04:05:06Z');
      let requests = 0;
      server = createServer((_request, response) => {
        requests++;
        response.writeHead(200, {'Connection': 'close', 'Content-Length': remote.length,
          'Last-Modified': remoteMtime.toUTCString()});
        response.end(remote);
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.bin`;
      const policy = jest.fn<ExistingResourceFunc>().mockImplementation(context => {
        if (context.stage === 'download') return action === 'ifModifiedSince' ? action : 'overwrite';
        expect(context.res.meta.headers?.['content-length']).toBe(String(remote.length));
        expect(context.res.meta.headers?.['last-modified']).toBe(remoteMtime.toUTCString());
        expect(readFileSync(context.localPath)).toEqual(cached);
        expect(statSync(context.localPath).mtimeMs).toBe(originalMtime);
        return action;
      });
      const after = jest.fn<() => void>();
      const lifecycle = defaultLifeCycle();
      if (hooked) lifecycle.download[1] = downloadStreamingResourceWithHook(undefined, after);
      const options = defaultDownloadOptions({...lifecycle, httpTransport, localRoot: root,
        existingResource: policy, preferRemoteLastModifiedTime: true,
        req: {retry: {limit: 0}, timeout: {request: 2000}}, meta: {}});
      const executor = new PipelineExecutorImpl(options, options.req, options);
      const resource = await executor.createResource(ResourceType.StreamingBinary, 0, url, url);
      const file = path.join(root, resource.savePath);
      await fs.mkdir(path.dirname(file), {recursive: true});
      await fs.writeFile(file, cached);
      await fs.utimes(file, cachedMtime, cachedMtime);
      const originalMtime = (await fs.stat(file)).mtimeMs;

      await expect(executor.download(resource)).resolves.toBe(true);

      expect(requests).toBe(1);
      expect(policy.mock.calls.map(([context]) => context.stage)).toEqual(['download', 'saveToDisk']);
      expect(await fs.readFile(file)).toEqual(cached);
      expect((await fs.stat(file)).mtimeMs).toBe(originalMtime);
      expect(after).toHaveBeenCalledTimes(hooked ? 1 : 0);
      if (httpTransport === 'native') expect(resource.meta.httpTransport).toBe('native');
    });

  test('saves a new destination without calling the existing-file policy', async () => {
    const remote = Buffer.from('new streaming bytes');
    server = createServer((_request, response) => {
      response.writeHead(200, {'Connection': 'close'});
      response.end(remote);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.bin`;
    const policy = jest.fn<ExistingResourceFunc>().mockReturnValue('skipSave');
    const lifecycle = defaultLifeCycle();
    if (hooked) lifecycle.download[1] = downloadStreamingResourceWithHook(res => res);
    const options = defaultDownloadOptions({...lifecycle, httpTransport, localRoot: root,
      existingResource: policy, req: {retry: {limit: 0}, timeout: {request: 2000}}, meta: {}});
    const executor = new PipelineExecutorImpl(options, options.req, options);
    const resource = await executor.createResource(ResourceType.StreamingBinary, 0, url, url);

    await expect(executor.download(resource)).resolves.toBe(true);

    expect(policy).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, resource.savePath))).toEqual(remote);
  });

  test('does not open cached output when the response-aware policy throws', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, {'Connection': 'close', 'Content-Length': 4});
      response.end('body');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.bin`;
    const failure = new Error('policy failed');
    const policy = jest.fn<ExistingResourceFunc>().mockImplementation(context => {
      if (context.stage === 'download') return 'overwrite';
      expect(context.res.meta.headers?.['content-length']).toBe('4');
      throw failure;
    });
    const after = jest.fn<() => void>();
    const lifecycle = defaultLifeCycle();
    if (hooked) lifecycle.download[1] = downloadStreamingResourceWithHook(undefined, after);
    const options = defaultDownloadOptions({...lifecycle, httpTransport, localRoot: root,
      existingResource: policy, req: {retry: {limit: 0}, timeout: {request: 2000}}, meta: {}});
    const executor = new PipelineExecutorImpl(options, options.req, options);
    const resource = await executor.createResource(ResourceType.StreamingBinary, 0, url, url);
    const file = path.join(root, resource.savePath);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, 'cached');
    await fs.utimes(file, 1000000, 1000000);
    const originalMtime = (await fs.stat(file)).mtimeMs;

    await expect(executor.download(resource)).rejects.toBe(failure);

    expect(await fs.readFile(file, 'utf8')).toBe('cached');
    expect((await fs.stat(file)).mtimeMs).toBe(originalMtime);
    expect(after).not.toHaveBeenCalled();
  });

  test('does not open cached output when the save decision aborts the request', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, {'Connection': 'close', 'Content-Length': 4});
      response.end('body');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.bin`;
    const controller = new AbortController();
    const policy = jest.fn<ExistingResourceFunc>().mockImplementation(context => {
      if (context.stage === 'saveToDisk') {
        expect(context.res.meta.headers?.['content-length']).toBe('4');
        controller.abort();
      }
      return 'overwrite';
    });
    const after = jest.fn<() => void>();
    const lifecycle = defaultLifeCycle();
    if (hooked) lifecycle.download[1] = downloadStreamingResourceWithHook(undefined, after);
    const options = defaultDownloadOptions({...lifecycle, httpTransport, localRoot: root,
      existingResource: policy,
      req: {signal: controller.signal, retry: {limit: 0}, timeout: {request: 2000}}, meta: {}});
    const executor = new PipelineExecutorImpl(options, options.req, options);
    const resource = await executor.createResource(ResourceType.StreamingBinary, 0, url, url);
    const file = path.join(root, resource.savePath);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, 'cached');
    await fs.utimes(file, 1000000, 1000000);
    const originalMtime = (await fs.stat(file)).mtimeMs;

    await expect(executor.download(resource)).rejects.toMatchObject({name: 'AbortError'});

    expect(await fs.readFile(file, 'utf8')).toBe('cached');
    expect((await fs.stat(file)).mtimeMs).toBe(originalMtime);
    expect(after).not.toHaveBeenCalled();
  });

  test('retries a truncated skipped response without touching cached output or repeating save policy', async () => {
    const remote = Buffer.from('complete skipped body');
    const ranges: Array<string | undefined> = [];
    server = createServer((request, response) => {
      ranges.push(request.headers.range);
      response.writeHead(200, {'Connection': 'close', 'Content-Length': remote.length,
        'Accept-Ranges': 'bytes'});
      if (ranges.length === 1) {
        response.write(remote.subarray(0, 4));
        void delay(20).then(() => response.destroy());
      } else {
        response.end(remote);
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.bin`;
    const policy = jest.fn<ExistingResourceFunc>().mockReturnValue('skipSave');
    const after = jest.fn<() => void>();
    const lifecycle = defaultLifeCycle();
    if (hooked) lifecycle.download[1] = downloadStreamingResourceWithHook(undefined, after);
    const options = defaultDownloadOptions({...lifecycle, httpTransport, localRoot: root,
      existingResource: policy,
      req: {retry: httpTransport === 'native' ? {limit: 1, backoffLimit: 1, noise: 0} :
        {limit: 1, calculateDelay: ({attemptCount}) => attemptCount <= 1 ? 1 : 0},
      timeout: {request: 2000}}, meta: {}});
    const executor = new PipelineExecutorImpl(options, options.req, options);
    const resource = await executor.createResource(ResourceType.StreamingBinary, 0, url, url);
    const file = path.join(root, resource.savePath);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, 'cached');
    await fs.utimes(file, 1000000, 1000000);
    const originalMtime = (await fs.stat(file)).mtimeMs;

    await expect(executor.download(resource)).resolves.toBe(true);

    expect(ranges).toEqual([undefined, undefined]);
    expect(policy.mock.calls.map(([context]) => context.stage)).toEqual(['download', 'saveToDisk']);
    expect(await fs.readFile(file, 'utf8')).toBe('cached');
    expect((await fs.stat(file)).mtimeMs).toBe(originalMtime);
    expect(after).toHaveBeenCalledTimes(hooked ? 1 : 0);
  });
});

describe.each([
  {name: 'Got', withPolicy: false, native: false},
  {name: 'Got with save policy', withPolicy: true, native: false},
  {name: 'native with save policy', withPolicy: true, native: true}
])('$name streaming retries', ({withPolicy, native}) => {
  test.each([[true, false], [false, false], [true, true]])(
    'preserves bytes (honors Range: %s, interrupted retry: %s)',
    async (honorsRange, interruptedRetry) => {
      const bytes = Buffer.from('complete binary data');
      const prefixLength = 4;
      const ranges: Array<string | undefined> = [];
      let destination = '';
      server = createServer((request, response) => {
        ranges.push(request.headers.range);
        if (ranges.length === 1) {
          response.writeHead(200, {
            'Connection': 'close',
            'Accept-Ranges': 'bytes',
            'Content-Length': bytes.length
          });
          response.write(bytes.subarray(0, prefixLength));
          void (async () => {
            // Interrupt only after the prefix has reached the destination file.
            for (let attempt = 0; attempt < 200; attempt++) {
              const stat = await fs.stat(destination).catch(() => undefined);
              if (stat?.size === prefixLength) break;
              await delay(10);
            }
            response.destroy();
          })();
        } else if (interruptedRetry && ranges.length === 2) {
          response.destroy();
        } else if (honorsRange) {
          response.writeHead(206, {
            'Connection': 'close',
            'Content-Range': 'bytes ' + prefixLength + '-' +
              (bytes.length - 1) + '/' + bytes.length
          });
          response.end(bytes.subarray(prefixLength));
        } else {
          response.writeHead(200, {'Connection': 'close'});
          response.end(bytes);
        }
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = 'http://127.0.0.1:' +
        (server.address() as AddressInfo).port + '/file.bin';
      const policy = jest.fn<ExistingResourceFunc>().mockReturnValue('overwrite');
      const options = defaultDownloadOptions({
        ...defaultLifeCycle(),
        localRoot: root,
        httpTransport: native ? 'native' : 'got',
        existingResource: withPolicy ? policy : undefined,
        req: {
          retry: native ? {limit: 2, backoffLimit: 1, noise: 0} : {
            limit: 2,
            calculateDelay: ({attemptCount}) => attemptCount <= 2 ? 1 : 0
          },
          timeout: {request: 4000}
        },
        meta: {}
      });
      const pipeline = new PipelineExecutorImpl(options, options.req, options);
      const resource = await pipeline.createResource(ResourceType.StreamingBinary,
        0, url, url);
      if (!resource) throw new Error('Resource was discarded');
      destination = path.join(root, resource.savePath);
      if (withPolicy) {
        await fs.mkdir(path.dirname(destination), {recursive: true});
        await fs.writeFile(destination, 'old cached bytes');
      }

      await expect(pipeline.download(resource)).resolves.toBe(true);

      expect(ranges).toEqual(interruptedRetry ?
        [undefined, 'bytes=4-', 'bytes=4-'] : [undefined, 'bytes=4-']);
      expect(await fs.readFile(destination)).toEqual(bytes);
      if (withPolicy) {
        expect(policy.mock.calls.map(([context]) => context.stage)).toEqual(['download', 'saveToDisk']);
      }
      if (native) expect(resource.meta.httpTransport).toBe('native');
    }, 10000);
});
