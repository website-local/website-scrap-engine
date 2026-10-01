import {describe, expect, test} from '@jest/globals';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {withCrawlContext} from '../../src/crawl-context.js';
import {createDefaultLogger} from '../../src/logger/default-logger.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
// noinspection ES6PreferShortImport
import {
  downloadStreamingResource,
  isBytesAccepted,
  isSameRangeStart,
  shouldWaitForRequestError,
  streamingDownloadToFile
} from '../../src/life-cycle/download-streaming-resource.js';
import type {Resource} from '../../src/resource.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {RequestOptions} from '../../src/life-cycle/types.js';
import type {StaticDownloadOptions} from '../../src/options.js';

test('direct streaming checks response-dependent save policy before opening output', async () => {
  const root = await fs.mkdtemp(join(process.cwd(), '.wse-direct-stream-'));
  const server = createServer((_request, response) => {
    response.setHeader('Connection', 'close');
    response.setHeader('Last-Modified', new Date(0).toUTCString());
    response.end('replacement');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const url = 'http://127.0.0.1:' + address.port + '/asset';
    const destination = join(root, 'asset');
    await fs.writeFile(destination, 'cached');
    const before = await fs.stat(destination);
    const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root,
      existingResource: () => 'ifModifiedSince'});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const res = {...createResource({type: ResourceType.StreamingBinary, depth: 0,
      url, refUrl: url, localRoot: root, savePath: 'asset'}), downloadStartTimestamp: Date.now()};
    const context = {directWrites: true, signal: new AbortController().signal, logger: createDefaultLogger()};
    await withCrawlContext(context, () => streamingDownloadToFile(res,
      {retry: {limit: 0}, timeout: {request: 2000}}, pipeline, options));
    expect(await fs.readFile(destination, 'utf8')).toBe('cached');
    expect((await fs.stat(destination)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, {recursive: true, force: true});
  }
});

describe('isBytesAccepted', function () {
  test('returns false for undefined', () => {
    expect(isBytesAccepted(undefined)).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isBytesAccepted('')).toBe(false);
  });

  test('returns true for bytes', () => {
    expect(isBytesAccepted('bytes')).toBe(true);
  });

  test('returns false for none', () => {
    expect(isBytesAccepted('none')).toBe(false);
  });

  test('returns true for comma-separated with bytes', () => {
    expect(isBytesAccepted('none,bytes')).toBe(true);
  });

  test('returns false for comma-separated without bytes', () => {
    expect(isBytesAccepted('none,other')).toBe(false);
  });
});

describe('isSameRangeStart', function () {
  test('returns false for undefined', () => {
    expect(isSameRangeStart(0, undefined)).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isSameRangeStart(0, '')).toBe(false);
  });

  test('returns true for matching range start', () => {
    expect(isSameRangeStart(100, 'bytes 100-200/300')).toBe(true);
  });

  test('returns false for non-matching range start', () => {
    expect(isSameRangeStart(50, 'bytes 100-200/300')).toBe(false);
  });

  test('returns true for range start 0', () => {
    expect(isSameRangeStart(0, 'bytes 0-200/300')).toBe(true);
  });

  test('returns false for missing space separator', () => {
    expect(isSameRangeStart(0, 'bytes')).toBe(false);
  });
});

describe('shouldWaitForRequestError', function () {
  test('returns true for request-originated stream failures', () => {
    expect(shouldWaitForRequestError({name: 'RequestError'})).toBe(true);
    expect(shouldWaitForRequestError({name: 'TimeoutError'})).toBe(true);
  });

  test('returns false for destination write failures', () => {
    const err = Object.assign(new Error('no space left on device'), {
      code: 'ENOSPC',
      name: 'Error'
    });

    expect(shouldWaitForRequestError(err)).toBe(false);
  });
});

describe('downloadStreamingResource', function () {
  // A non-http downloadLink (e.g. file://) must not be handed to got.stream();
  // it should fall through unchanged to the next (local) download handler.
  test('falls through for non-http downloadLink', async () => {
    const res = {
      type: ResourceType.StreamingBinary,
      downloadLink: 'file:///tmp/does-not-matter.bin',
      createTimestamp: Date.now()
    } as unknown as Resource;
    const result = await downloadStreamingResource(
      res, {} as RequestOptions, {} as StaticDownloadOptions);
    // returned verbatim, no download timestamps set (got.stream not invoked)
    expect(result).toBe(res);
    expect(res.downloadStartTimestamp).toBeUndefined();
  });
});
