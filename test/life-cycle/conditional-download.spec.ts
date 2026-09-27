import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {promises as fs} from 'node:fs';
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
      if (downloaded) {
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
    if (downloaded) {
      const processed = await pipeline.processAfterDownload(downloaded, () => {});
      if (processed) await pipeline.saveToDisk(processed);
    }

    expect(requests).toBe(1);
    expect(await fs.readFile(file)).toEqual(updated);
    expect(afterDownload).toHaveBeenCalledTimes(hooked ? 1 : 0);
  });
});

describe('streaming retries', () => {
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
      const options = defaultDownloadOptions({
        ...defaultLifeCycle(),
        localRoot: root,
        req: {
          retry: {
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

      await pipeline.download(resource);

      expect(ranges).toEqual(interruptedRetry ?
        [undefined, 'bytes=4-', 'bytes=4-'] : [undefined, 'bytes=4-']);
      expect(await fs.readFile(destination)).toEqual(bytes);
    }, 10000);
});
