import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {load} from 'cheerio';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
// noinspection ES6PreferShortImport
import {
  downloadStreamingResource,
  downloadStreamingResourceWithHook,
  isBytesAccepted,
  isSameRangeStart,
  shouldWaitForRequestError
} from '../../src/life-cycle/download-streaming-resource.js';
import type {
  StreamingAfterDownloadHook,
  StreamingBeforeDownloadHook,
  StreamingDownloadErrorHook
} from '../../src/life-cycle/download-streaming-resource.js';
import {disposeHtmlResource} from '../../src/cheerio.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import type {Resource} from '../../src/resource.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {RequestOptions} from '../../src/life-cycle/types.js';
import type {StaticDownloadOptions} from '../../src/options.js';
import {defaultDownloadOptions} from '../../src/options.js';

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

describe('streaming hook ownership and failures', () => {
  let root: string;
  let baseUrl: string;
  let server: Server;
  let requests: string[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'wse-streaming-hooks-'));
    requests = [];
    server = createServer((request, response) => {
      const url = request.url ?? '/';
      requests.push(url);
      response.writeHead(url === '/failure.bin' ? 503 : 200, {'Connection': 'close'});
      response.end('body from ' + url);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await fs.rm(root, {recursive: true, force: true});
  });

  function resource(name: string): Resource {
    return createResource({type: ResourceType.StreamingBinary, depth: 0,
      url: baseUrl + '/' + name + '.bin', refUrl: baseUrl + '/', localRoot: root});
  }

  function ownDocument(res: Resource) {
    const document: ReturnType<typeof load> & {dispose?: () => void} = load('<p>owned</p>');
    const dispose = jest.fn<() => void>();
    document.dispose = dispose;
    res.meta.doc = document;
    return {document, dispose};
  }

  function pipelineWith(
    before?: StreamingBeforeDownloadHook,
    after?: StreamingAfterDownloadHook,
    error?: StreamingDownloadErrorHook
  ) {
    const lifecycle = defaultLifeCycle();
    lifecycle.download[1] = downloadStreamingResourceWithHook(before, after, error);
    const options = defaultDownloadOptions({...lifecycle, localRoot: root,
      req: {retry: {limit: 0}, timeout: {request: 2000}}, meta: {}});
    return new PipelineExecutorImpl(options, options.req, options);
  }

  test('uses a bodyless replacement URL and releases each owned document at its boundary', async () => {
    const original = resource('original');
    const replacement = resource('replacement');
    const originalOwner = ownDocument(original);
    const replacementOwner = ownDocument(replacement);
    const after = jest.fn<StreamingAfterDownloadHook>().mockImplementation(res => {
      expect(res).toBe(replacement);
      expect(originalOwner.dispose).toHaveBeenCalledTimes(1);
      expect(replacement.meta.doc).toBe(replacementOwner.document);
      expect(replacementOwner.dispose).not.toHaveBeenCalled();
    });
    const executor = pipelineWith(() => replacement, after);

    await expect(executor.download(original)).resolves.toBe(true);

    expect(requests).toEqual(['/replacement.bin']);
    expect(await fs.readFile(path.join(root, replacement.savePath), 'utf8')).toBe('body from /replacement.bin');
    await expect(fs.stat(path.join(root, original.savePath))).rejects.toMatchObject({code: 'ENOENT'});
    expect(after).toHaveBeenCalledTimes(1);
    expect(original.redirectedUrl).toBe(baseUrl + '/replacement.bin');
    expect(original.meta.doc).toBeUndefined();
    expect(replacement.meta.doc).toBeUndefined();
    expect(originalOwner.dispose).toHaveBeenCalledTimes(1);
    expect(replacementOwner.dispose).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('retains a shared document through the after hook (shared metadata: %s)', async sharedMeta => {
    const original = resource('original');
    const owner = ownDocument(original);
    const replacement = resource('replacement');
    replacement.meta = sharedMeta ? original.meta : {...original.meta};
    const after = jest.fn<StreamingAfterDownloadHook>().mockImplementation(res => {
      expect(res).toBe(replacement);
      expect(res.meta.doc).toBe(owner.document);
      expect(owner.dispose).not.toHaveBeenCalled();
    });

    await expect(pipelineWith(() => replacement, after).download(original)).resolves.toBe(true);

    expect(after).toHaveBeenCalledTimes(1);
    expect(original.meta.doc).toBeUndefined();
    expect(replacement.meta.doc).toBeUndefined();
    expect(owner.dispose).toHaveBeenCalledTimes(1);
  });

  test('waits for status readers before transferring a shared document', async () => {
    const original = resource('original');
    const owner = ownDocument(original);
    const replacement = resource('replacement');
    replacement.meta.doc = owner.document;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const observations: unknown[] = [];
    const after = jest.fn<StreamingAfterDownloadHook>();
    const executor = pipelineWith(() => replacement, after);
    executor.lifeCycle.statusChange = [async res => {
      await gate;
      observations.push(res.meta.doc === owner.document, owner.dispose.mock.calls.length);
    }];
    const notification = executor.notifyStatusChange(original, 'download');
    const downloading = executor.download(original);

    expect(original.meta.doc).toBe(owner.document);
    expect(after).not.toHaveBeenCalled();
    release();
    await notification;
    await expect(downloading).resolves.toBe(true);

    expect(observations).toEqual([true, 0]);
    expect(after).toHaveBeenCalledTimes(1);
    expect(original.meta.statusChanges).toBeUndefined();
    expect(owner.dispose).toHaveBeenCalledTimes(1);
  });

  test('hands a replacement body and its live document to the enclosing pipeline', async () => {
    const original = resource('original');
    const replacement = resource('replacement');
    replacement.body = Buffer.from('provided body');
    const originalOwner = ownDocument(original);
    const replacementOwner = ownDocument(replacement);
    const after = jest.fn<StreamingAfterDownloadHook>();

    const downloaded = await pipelineWith(() => replacement, after).download(original);

    expect(downloaded).toBe(replacement);
    expect(requests).toEqual([]);
    expect(after).not.toHaveBeenCalled();
    expect(originalOwner.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.meta.doc).toBe(replacementOwner.document);
    expect(replacementOwner.dispose).not.toHaveBeenCalled();
    await disposeHtmlResource(replacement);
    expect(replacementOwner.dispose).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('disposes a discarded replacement (supplied body: %s)', async suppliedBody => {
    const original = resource('original');
    const replacement = resource('replacement');
    const originalOwner = ownDocument(original);
    const replacementOwner = ownDocument(replacement);
    replacement.shouldBeDiscardedFromDownload = true;
    if (suppliedBody) replacement.body = Buffer.from('discarded body');
    const after = jest.fn<StreamingAfterDownloadHook>();

    await expect(pipelineWith(() => replacement, after).download(original)).resolves.toBeUndefined();

    expect(requests).toEqual([]);
    expect(after).not.toHaveBeenCalled();
    expect(originalOwner.dispose).toHaveBeenCalledTimes(1);
    expect(replacementOwner.dispose).toHaveBeenCalledTimes(1);
  });

  test('passes a bodyless local replacement to the local copy handler without early disposal', async () => {
    const original = resource('original');
    const originalOwner = ownDocument(original);
    const input = path.join(root, 'input.bin');
    await fs.writeFile(input, 'local replacement');
    const url = pathToFileURL(input).href;
    const replacement = createResource({type: ResourceType.StreamingBinary, depth: 0,
      url, refUrl: url, localRoot: path.join(root, 'copy'),
      localSrcRoot: pathToFileURL(root).href.slice('file:///'.length)});
    const replacementOwner = ownDocument(replacement);
    const after = jest.fn<StreamingAfterDownloadHook>();

    await expect(pipelineWith(() => replacement, after).download(original)).resolves.toBe(true);

    expect(requests).toEqual([]);
    expect(await fs.readFile(path.join(replacement.localRoot, replacement.savePath), 'utf8'))
      .toBe('local replacement');
    expect(after).not.toHaveBeenCalled();
    expect(originalOwner.dispose).toHaveBeenCalledTimes(1);
    expect(replacementOwner.dispose).toHaveBeenCalledTimes(1);
  });

  test('preserves the original download error after a void observer and disposes the replacement', async () => {
    const original = resource('original');
    const replacement = resource('failure');
    const originalOwner = ownDocument(original);
    const replacementOwner = ownDocument(replacement);
    const after = jest.fn<StreamingAfterDownloadHook>();
    const observe = jest.fn<StreamingDownloadErrorHook>().mockImplementation((_error, res) => {
      expect(res).toBe(replacement);
      expect(res.meta.doc).toBe(replacementOwner.document);
      expect(replacementOwner.dispose).not.toHaveBeenCalled();
    });
    const downloading = pipelineWith(() => replacement, after, observe).download(original);

    await expect(downloading).rejects.toMatchObject({name: 'HTTPError'});
    const error = await downloading.catch(error => error);

    expect(observe).toHaveBeenCalledTimes(1);
    expect(error).toBe(observe.mock.calls[0][0]);
    expect(after).not.toHaveBeenCalled();
    expect(replacement.finishTimestamp).toBeUndefined();
    expect(original.redirectedUrl).toBeUndefined();
    expect(originalOwner.dispose).toHaveBeenCalledTimes(1);
    expect(replacementOwner.dispose).toHaveBeenCalledTimes(1);
  });

  test('disposes a replacement when the after hook throws', async () => {
    const original = resource('original');
    const replacement = resource('replacement');
    const originalOwner = ownDocument(original);
    const replacementOwner = ownDocument(replacement);
    const failure = new Error('after hook failed');
    const observe = jest.fn<StreamingDownloadErrorHook>();
    const executor = pipelineWith(() => replacement, () => { throw failure; }, observe);

    await expect(executor.download(original)).rejects.toBe(failure);

    expect(observe).not.toHaveBeenCalled();
    expect(original.redirectedUrl).toBeUndefined();
    expect(originalOwner.dispose).toHaveBeenCalledTimes(1);
    expect(replacementOwner.dispose).toHaveBeenCalledTimes(1);
  });

  test('retains the hook failure when replacement disposal also throws', async () => {
    const original = resource('original');
    const replacement = resource('replacement');
    const replacementOwner = ownDocument(replacement);
    const failure = new Error('after hook failed');
    const cleanupFailure = new Error('disposal failed');
    replacementOwner.dispose.mockImplementation(() => { throw cleanupFailure; });
    const executor = pipelineWith(() => replacement, () => { throw failure; });

    await expect(executor.download(original)).rejects.toMatchObject({
      name: 'AggregateError', errors: [failure, cleanupFailure]
    });
    expect(replacement.meta.doc).toBeUndefined();
    expect(original.redirectedUrl).toBeUndefined();
    expect(replacementOwner.dispose).toHaveBeenCalledTimes(1);
  });
});
