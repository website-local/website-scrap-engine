import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import type {RequestListener, Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {BeforeRetryHook} from 'got';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {ResourceType} from '../../src/resource.js';
import {getLogger, setLogger} from '../../src/logger/logger.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {getRetry} from '../../src/life-cycle/download-resource.js';

let root: string;
let server: Server;
const previousLogger = getLogger();

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'wse-download-'));
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

async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`;
}

describe.each(['text', 'buffer'] as const)('empty %s responses', responseType => {
  test.each([
    {method: 'GET', statusCode: 200},
    {method: 'GET', statusCode: 204},
    {method: 'HEAD', statusCode: 200}
  ] as const)('$method $statusCode completes in one request', async ({
    method, statusCode
  }) => {
    let requests = 0;
    const url = await listen((_request, response) => {
      requests++;
      if (statusCode === 200) {
        response.setHeader('Content-Length', method === 'HEAD' ? '12' : '0');
      }
      response.writeHead(statusCode);
      response.end();
    });

    const result = await getRetry(url, {
      method, responseType, retry: {limit: 0}, timeout: {request: 2000}
    });

    expect(result?.statusCode).toBe(statusCode);
    if (responseType === 'buffer') expect(Buffer.isBuffer(result?.body)).toBe(true);
    expect(result?.body).toEqual(responseType === 'buffer' ? Buffer.alloc(0) : '');
    expect(requests).toBe(1);
  });
});

describe('configured retries', () => {
  test.each([
    {method: 'GET', limit: 0, expectedRequests: 1},
    {method: 'GET', limit: 2, expectedRequests: 3},
    {method: 'POST', limit: 2, expectedRequests: 1}
  ] as const)('honors $method retry limit $limit on timeouts', async ({
    method, limit, expectedRequests
  }) => {
    let requests = 0;
    const beforeRetry = jest.fn<BeforeRetryHook>();
    const url = await listen((_request, response) => {
      requests++;
      // Any extra outer-loop request succeeds, making a retry-limit regression
      // fail promptly instead of leaving the test in repeated timeout backoffs.
      if (requests > expectedRequests) response.end('unexpected extra request');
    });

    await expect(getRetry(url, {
      method,
      responseType: 'buffer',
      timeout: {response: 100, request: 2000},
      retry: {
        limit,
        calculateDelay: ({computedValue}) => computedValue ? 1 : 0
      },
      hooks: {beforeRetry: [beforeRetry]}
    })).rejects.toMatchObject({code: 'ETIMEDOUT'});

    expect(requests).toBe(expectedRequests);
    expect(beforeRetry).toHaveBeenCalledTimes(expectedRequests - 1);
  });

  test('recovers from a transient timeout and runs retry hooks', async () => {
    let requests = 0;
    const beforeRetry = jest.fn<BeforeRetryHook>();
    const url = await listen((_request, response) => {
      if (++requests > 1) response.end('recovered');
    });

    const result = await getRetry(url, {
      responseType: 'buffer',
      timeout: {response: 100, request: 2000},
      retry: {
        limit: 1,
        calculateDelay: ({computedValue}) => computedValue ? 1 : 0
      },
      hooks: {beforeRetry: [beforeRetry]}
    });

    expect(result?.body).toEqual(Buffer.from('recovered'));
    expect(requests).toBe(2);
    expect(beforeRetry).toHaveBeenCalledTimes(1);
    expect(beforeRetry.mock.calls[0][1]).toBe(1);
  });
});

describe.each([
  {name: 'HTML', type: ResourceType.Html},
  {name: 'binary', type: ResourceType.Binary}
])('empty $name resources', ({type}) => {
  test.each([200, 204])('accepts status %i without another download', async status => {
    let requests = 0;
    const url = await listen((_request, response) => {
      requests++;
      response.writeHead(status);
      response.end();
    });
    const options = defaultDownloadOptions({
      ...defaultLifeCycle(),
      localRoot: root,
      req: {retry: {limit: 0}, timeout: {request: 2000}},
      meta: {detectIncompleteHtml: '</html>'}
    });
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const resource = await pipeline.createResource(type, 0, url, url);
    if (!resource) throw new Error('Resource was discarded');

    const downloaded = await pipeline.download(resource);

    expect(downloaded?.body).toEqual(Buffer.alloc(0));
    expect(requests).toBe(1);
    if (!downloaded) throw new Error('Download was discarded');
    if (type === ResourceType.Binary) {
      const processed = await pipeline.processAfterDownload(downloaded, () => {});
      if (!processed) throw new Error('Processing discarded empty content');
      await pipeline.saveToDisk(processed);
      expect(await fs.readFile(path.join(root, resource.savePath)))
        .toEqual(Buffer.alloc(0));
    }
  });
});


test('retries incomplete HTML with Got 16 binary responses', async () => {
  let requests = 0;
  const url = await listen((_request, response) => {
    response.end(++requests === 1 ? '<html>incomplete' : '<html>complete</html>');
  });
  const options = defaultDownloadOptions({
    ...defaultLifeCycle(), localRoot: root,
    req: {retry: {limit: 0}, timeout: {request: 2000}},
    meta: {detectIncompleteHtml: '</html>'}
  });
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const resource = await pipeline.createResource(ResourceType.Html, 0, url, url);
  if (!resource) throw new Error('Resource was discarded');
  const downloaded = await pipeline.download(resource);
  expect(requests).toBe(2);
  expect(Buffer.isBuffer(downloaded?.body)).toBe(true);
  expect(downloaded?.body.toString()).toBe('<html>complete</html>');
});
