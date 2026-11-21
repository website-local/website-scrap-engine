import {afterAll, beforeAll, describe, expect, jest, test} from '@jest/globals';
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import type {IncomingHttpHeaders} from 'node:http';
import type {AddressInfo} from 'node:net';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import type {MultiThreadDownloader} from '../../src/downloader/multi.js';
import type {SingleThreadDownloader} from '../../src/downloader/single.js';
import type {DownloadOptions} from '../../src/options.js';
import {prepareResourceForClone, ResourceType} from '../../src/resource.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
let root: string;
let buildRoot: string;
let Downloader: typeof MultiThreadDownloader;
let SingleDownloader: typeof SingleThreadDownloader;

beforeAll(async () => {
  // Native workers need emitted JS, including when npm test runs before a build.
  root = await fs.mkdtemp(path.join(projectRoot, '.wse-worker-test-'));
  buildRoot = process.env.WSE_TEST_BUILD_ROOT || path.join(root, 'lib');
  if (!process.env.WSE_TEST_BUILD_ROOT) {
    await promisify(execFile)(process.execPath, [
      path.join(projectRoot, 'node_modules/typescript/bin/tsc'),
      '--project', path.join(projectRoot, 'tsconfig.json'),
      '--outDir', buildRoot,
      '--declaration', 'false',
      '--declarationMap', 'false',
      '--sourceMap', 'false'
    ], {cwd: projectRoot, timeout: 30000});
  }
  const module = await import(pathToFileURL(
    path.join(buildRoot, 'downloader/multi.js')).href);
  Downloader = module.MultiThreadDownloader;
  SingleDownloader = (await import(pathToFileURL(
    path.join(buildRoot, 'downloader/single.js')).href)).SingleThreadDownloader;
}, 30000);

afterAll(async () => {
  if (root) await fs.rm(root, {recursive: true, force: true});
});

describe('downloader configuration before initialization', () => {
  test.each([
    ['init', false], ['init', true],
    ['processBeforeDownload', false], ['processBeforeDownload', true],
    ['cache', false], ['cache', true],
    ['headers', false], ['headers', true]
  ] as const)('refreshes handlers after %s changes (workers %s)', async (stage, workers) => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'startup-options-'));
    const entry = (name: string) => JSON.stringify(pathToFileURL(path.join(buildRoot, name)).href);
    const optionsPath = path.join(caseRoot, 'options.mjs');
    await fs.writeFile(optionsPath, [
      'import assert from "node:assert/strict";',
      'import {defaultDownloadOptions, selectDownloadHandlers} from ' + entry('options.js') + ';',
      'import {defaultLifeCycle} from ' + entry('life-cycle/default-life-cycle.js') + ';',
      'import {downloadResource, downloadResourceDirect} from ' + entry('life-cycle/download-resource.js') + ';',
      'import {downloadStreamingResource, downloadStreamingResourceDirect} from ' +
        entry('life-cycle/download-streaming-resource.js') + ';',
      'const options = defaultDownloadOptions({...defaultLifeCycle(),',
      '  localRoot: ' + JSON.stringify(caseRoot) + ',',
      '  concurrency: 1, workerCount: 1, initialUrl: [], statusChange: []});',
      'assert.equal(options.download[0], downloadResourceDirect);',
      'assert.equal(options.download[1], downloadStreamingResourceDirect);',
      'export const originalDownload = Object.freeze(options.download);',
      'export const request = options.req;',
      'export const headers = Object.freeze({"X-Startup": "updated after defaults"});',
      'export const cache = new Map();',
      'options.req.headers = headers;',
      'const enableCache = () => {',
      '  assert.equal(options.req, request);',
      '  assert.equal(options.req.headers, headers);',
      '  options.req.cache = cache;',
      '  selectDownloadHandlers(options);',
      '  assert.equal(options.download[0], downloadResource);',
      '  assert.equal(options.download[1], downloadStreamingResource);',
      '};',
      ...(stage === 'cache' ? ['options.req.cache = cache;'] : []),
      ...(stage === 'init' ? ['options.init.push(enableCache);'] : []),
      ...(stage === 'processBeforeDownload' ? [
        'options.processBeforeDownload.push(resource => {enableCache(); return resource;});'
      ] : []),
      'export const expectedDownload = ' + (stage === 'headers' ?
        '[downloadResourceDirect, downloadStreamingResourceDirect];' :
        '[downloadResource, downloadStreamingResource];'),
      'export default options;'
    ].join('\n'));
    const optionsUrl = pathToFileURL(optionsPath).href;
    const configured = await import(optionsUrl) as {
      default: DownloadOptions;
      originalDownload: DownloadOptions['download'];
      expectedDownload: DownloadOptions['download'];
      request: DownloadOptions['req'];
      headers: NonNullable<DownloadOptions['req']['headers']>;
      cache: Map<string, string>;
    };
    const downloader = workers ? new Downloader(optionsUrl) : new SingleDownloader(optionsUrl);
    try {
      await downloader.init;
      expect(downloader.options).toBe(configured.default);
      expect(downloader.pipeline.requestOptions).toBe(configured.request);
      expect(configured.request.headers).toBe(configured.headers);
      expect(downloader.options.download.slice(0, 2)).toEqual(stage === 'processBeforeDownload' ?
        configured.originalDownload.slice(0, 2) : configured.expectedDownload);
      expect(Object.isFrozen(configured.originalDownload)).toBe(true);
      const child = downloader.pipeline.createResource(ResourceType.Binary, 1,
        'https://example.test/pixel.bin', 'https://example.test/index.html');
      expect(await downloader.pipeline.processBeforeDownload(child, null, null)).toBe(child);
      expect(downloader.options.download.slice(0, 2)).toEqual(configured.expectedDownload);
      if (stage === 'headers') {
        expect(downloader.options.download).toBe(configured.originalDownload);
      } else {
        expect(downloader.options.download).not.toBe(configured.originalDownload);
        expect(configured.originalDownload.slice(0, 2)).not.toEqual(configured.expectedDownload);
      }
      expect(configured.request.cache).toBe(stage === 'headers' ? undefined : configured.cache);

      if (workers) {
        const resource = downloader.pipeline.createResource(ResourceType.Html, 0,
          'https://example.test/index.html', 'https://example.test/index.html');
        resource.body = '<html><body><img src="/pixel.bin"></body></html>';
        const message = await (downloader as MultiThreadDownloader).pool.submitTask(prepareResourceForClone(resource));
        expect(message.error).toBeUndefined();
        expect(message.body?.map(value => value.url)).toEqual(['https://example.test/pixel.bin']);
        expect(await fs.readFile(path.join(caseRoot, 'example.test/index.html'), 'utf8')).toContain('pixel.bin');
      }
    } finally {
      await downloader.dispose();
    }
  });
});

async function writeOptions(caseRoot: string, fields: string[], preamble: string[] = []): Promise<string> {
  const entry = (name: string) => JSON.stringify(pathToFileURL(path.join(buildRoot, name)).href);
  const optionsPath = path.join(caseRoot, 'options.mjs');
  await fs.writeFile(optionsPath, [
    'import {defaultDownloadOptions} from ' + entry('options.js') + ';',
    'import {defaultLifeCycle} from ' + entry('life-cycle/default-life-cycle.js') + ';',
    'import {ResourceType} from ' + entry('resource.js') + ';',
    'import {getLogger} from ' + entry('logger/logger.js') + ';',
    ...preamble,
    'export default defaultDownloadOptions({',
    '  ...defaultLifeCycle(), localRoot: ' + JSON.stringify(caseRoot) + ',',
    '  initialUrl: [], concurrency: 2, workerCount: 2, statusChange: [],',
    '  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {},',
    '    isTraceEnabled: () => false}),',
    ...fields,
    '});'
  ].join('\n'));
  return pathToFileURL(optionsPath).href;
}

describe('MultiThreadDownloader', () => {
  test.each([
    ['download', false], ['process', false], ['save', false],
    ['download', true], ['process', true], ['save', true]
  ] as const)('%s failures can be resubmitted without counting success (workers %s)', async (stage, workers) => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'failure-retry-'));
    const bytes = Buffer.from('complete retry response');
    let requests = 0;
    const server = createServer((_request, response) => {
      ++requests;
      response.setHeader('Connection', 'close');
      response.statusCode = stage === 'download' && requests === 1 ? 500 : 200;
      response.end(bytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/retry.bin';
    const options = await writeOptions(caseRoot, [
      'concurrency: 1, workerCount: 1,',
      'req: {retry: {limit: 0}, throwHttpErrors: true, timeout: {request: 2000}},',
      ...(stage === 'process' ? ['processAfterDownload: [...defaultLifeCycle().processAfterDownload, failOnce],'] : []),
      ...(stage === 'save' ? ['saveToDisk: [failOnce, ...defaultLifeCycle().saveToDisk],'] : [])
    ], [
      'let attempts = 0;',
      'const failOnce = resource => {',
      '  if (++attempts === 1) throw new Error("first processing attempt failed");',
      '  return resource;',
      '};'
    ]);
    const downloader = workers ? new Downloader(options) : new SingleDownloader(options);
    const handleError = jest.spyOn(downloader, 'handleError');
    try {
      await downloader.init;
      const make = (suffix: string) => downloader.pipeline.createResource(
        ResourceType.Binary, 0, url + suffix, url);
      downloader.stop();
      const first = make('?attempt=1#first');
      expect(downloader.addProcessedResource(first)).not.toBe(false);
      expect(downloader.addProcessedResource(make('?duplicate=1#active'))).toBe(false);
      downloader.start();
      await downloader.onIdle();
      expect(handleError).toHaveBeenCalledTimes(1);
      expect(first.meta.error).toBeDefined();
      expect(downloader.downloadedCount).toBe(0);
      expect(downloader.queuedUrl.has(url)).toBe(false);
      await expect(fs.readFile(path.join(caseRoot, '127.0.0.1/retry.bin')))
        .rejects.toMatchObject({code: 'ENOENT'});

      const retry = make('?attempt=2#retry');
      expect(downloader.addProcessedResource(retry)).not.toBe(false);
      await downloader.onIdle();
      expect(handleError).toHaveBeenCalledTimes(1);
      expect(requests).toBe(2);
      expect(downloader.downloadedCount).toBe(1);
      expect(downloader.downloadedUrl.has(retry.url)).toBe(true);
      expect(downloader.queuedUrl.has(url)).toBe(true);
      expect(await fs.readFile(path.join(caseRoot, '127.0.0.1/retry.bin'))).toEqual(bytes);
      expect(downloader.addProcessedResource(make('?duplicate=2#saved'))).toBe(false);

      downloader.pipeline.lifeCycle.download = [() => { throw new Error('direct-call failure'); }];
      await downloader.downloadAndProcessResource(make('?direct=1#failed'));
      expect(handleError).toHaveBeenCalledTimes(2);
      expect(downloader.downloadedCount).toBe(1);
      expect(downloader.queuedUrl.has(url)).toBe(true);
      expect(downloader.addProcessedResource(make('?duplicate=3#after-direct'))).toBe(false);
    } finally {
      await downloader.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });

  test.each([false, true])('failure callbacks can immediately resubmit before the old attempt settles (workers %s)', async workers => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'callback-retry-'));
    const bytes = Buffer.from('complete callback retry');
    let requests = 0;
    const server = createServer((_request, response) => {
      ++requests;
      response.setHeader('Connection', 'close');
      response.end(bytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/callback.bin';
    const options = await writeOptions(caseRoot, [
      'concurrency: 1, workerCount: 1,',
      'req: {retry: {limit: 0}, throwHttpErrors: true, timeout: {request: 2000}},',
      'processAfterDownload: [resource => {',
      '  if (++attempts === 1) throw new Error("retry from the observer");',
      '  return resource;',
      '}],'
    ], ['let attempts = 0;']);
    const downloader = workers ? new Downloader(options) : new SingleDownloader(options);
    const observations: unknown[][] = [];
    const handleError = downloader.handleError.bind(downloader);
    jest.spyOn(downloader, 'handleError').mockImplementation((error, cause, resource) => {
      observations.push(['handleError', downloader.queuedUrl.has(url), downloader.downloadedCount]);
      handleError(error, cause, resource);
    });
    try {
      await downloader.init;
      const make = () => downloader.pipeline.createResource(ResourceType.Binary, 0, url + '#retry', url);
      downloader.pipeline.lifeCycle.statusChange = [(_resource, status) => {
        if (status !== 'error') return;
        observations.push(['status', downloader.queuedUrl.has(url), downloader.downloadedCount]);
        const admitted = downloader.addProcessedResource(make());
        observations.push(['resubmitted', admitted !== false, downloader.queuedUrl.has(url)]);
      }];
      downloader.addProcessedResource(make());
      await downloader.onIdle();
      expect(observations).toEqual([
        ['handleError', false, 0], ['status', false, 0], ['resubmitted', true, true]
      ]);
      expect(requests).toBe(2);
      expect(downloader.downloadedCount).toBe(1);
      expect(downloader.queuedUrl.has(url)).toBe(true);
      expect(downloader.addProcessedResource(make())).toBe(false);
      expect(await fs.readFile(path.join(caseRoot, '127.0.0.1/callback.bin'))).toEqual(bytes);
    } finally {
      await downloader.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });

  test.each([
    [false, false], [false, true], [true, false], [true, true]
  ])('parent disposer failures release admissions and aliases before retry (workers %s, status wait %s)', async (workers, pendingStatus) => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'dispose-retry-'));
    const options = await writeOptions(caseRoot, [
      'concurrency: 1, workerCount: 1,',
      'download: [res => res], processAfterDownload: [res => res], saveToDisk: [res => res],'
    ]);
    const downloader = workers ? new Downloader(options) : new SingleDownloader(options);
    const handleError = jest.spyOn(downloader, 'handleError');
    const url = 'https://example.test/dispose.bin';
    const counted = jest.spyOn(downloader.downloadedUrl, 'add');
    const target = 'https://example.test/dispose-target.bin';
    const failure = new Error('parent disposal failed');
    const dispose = jest.fn<() => void>().mockImplementation(() => { throw failure; });
    const observations: unknown[][] = [];
    try {
      await downloader.init;
      const make = (attempt: number) => {
        const resource = downloader.pipeline.createResource(ResourceType.Binary, 0,
          url + '?attempt=' + attempt, url);
        resource.body = 'provided bytes';
        resource.redirectedUrl = target;
        return resource;
      };
      const first = make(1);
      first.meta.doc = {dispose} as unknown as NonNullable<typeof first.meta.doc>;
      if (pendingStatus) first.meta.statusChanges = [Promise.resolve()];
      const retry = make(2);
      downloader.pipeline.lifeCycle.statusChange = [(_resource, status) => {
        if (status !== 'error') return;
        observations.push(['error', downloader.downloadedCount,
          downloader.queuedUrl.has(url), downloader.queuedUrl.has(target)]);
        const admitted = downloader.addProcessedResource(retry);
        observations.push(['retry', admitted !== false, downloader.queuedUrl.has(url)]);
        return Promise.resolve().then(() => {
          observations.push(['settled', downloader.downloadedCount, downloader.queuedUrl.has(url)]);
          throw new Error('ignored error observer rejection');
        });
      }];

      downloader.addProcessedResource(first);
      await downloader.onIdle();

      expect(observations).toEqual([
        ['error', 0, false, false], ['retry', true, true], ['settled', 0, true]
      ]);
      expect(handleError).toHaveBeenCalledTimes(1);
      expect(first.meta.error).toBe(failure);
      expect(first.meta.doc).toBeUndefined();
      expect(first.meta.statusChanges).toBeUndefined();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(downloader.downloadedCount).toBe(1);
      expect(first.url).toBe(retry.url);
      expect(counted).toHaveBeenCalledTimes(1);
      expect(counted).toHaveBeenCalledWith(retry.url);
      expect(downloader.downloadedUrl.has(retry.url)).toBe(true);
      expect(downloader.queuedUrl.has(url)).toBe(true);
      expect(downloader.queuedUrl.has(target)).toBe(true);
    } finally { await downloader.dispose(); }
  });

  test.each([false, true])('worker disposer failures remain uncounted and retryable (status wait %s)', async pendingStatus => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'worker-dispose-retry-'));
    const target = 'https://example.test/worker-dispose-target.bin';
    const options = await writeOptions(caseRoot, [
      'concurrency: 1, workerCount: 1, download: [res => res], saveToDisk: [res => res],',
      'processAfterDownload: [res => {',
      '  if (++attempts === 1) {',
      '    res.meta.doc = {dispose() {throw new Error("worker disposal failed");}};',
      ...(pendingStatus ? ['    res.meta.statusChanges = [Promise.resolve()];'] : []),
      '  }',
      '  res.redirectedUrl = ' + JSON.stringify(target) + '; return res;',
      '}],'
    ], ['let attempts = 0;']);
    const downloader = new Downloader(options);
    const handleError = jest.spyOn(downloader, 'handleError');
    const url = 'https://example.test/worker-dispose.bin';
    const counted = jest.spyOn(downloader.downloadedUrl, 'add');
    const observations: unknown[][] = [];
    try {
      await downloader.init;
      const make = (attempt: number) => {
        const resource = downloader.pipeline.createResource(ResourceType.Binary, 0,
          url + '?attempt=' + attempt, url);
        resource.body = 'provided bytes';
        return resource;
      };
      const first = make(1);
      const retry = make(2);
      downloader.pipeline.lifeCycle.statusChange = [(_resource, status) => {
        if (status !== 'error') return;
        observations.push(['error', downloader.downloadedCount,
          downloader.queuedUrl.has(url), downloader.queuedUrl.has(target)]);
        const admitted = downloader.addProcessedResource(retry);
        observations.push(['retry', admitted !== false, downloader.queuedUrl.has(url)]);
        return Promise.resolve().then(() => {
          observations.push(['settled', downloader.downloadedCount, downloader.queuedUrl.has(url)]);
        });
      }];

      downloader.addProcessedResource(first);
      await downloader.onIdle();

      expect(observations).toEqual([
        ['error', 0, false, false], ['retry', true, true], ['settled', 0, true]
      ]);
      expect(handleError).toHaveBeenCalledTimes(1);
      expect(first.meta.error).toMatchObject({message: 'worker disposal failed'});
      expect(first.meta.statusChanges).toBeUndefined();
      expect(downloader.downloadedCount).toBe(1);
      expect(first.url).toBe(retry.url);
      expect(counted).toHaveBeenCalledTimes(1);
      expect(counted).toHaveBeenCalledWith(retry.url);
      expect(downloader.downloadedUrl.has(retry.url)).toBe(true);
      expect(downloader.queuedUrl.has(url)).toBe(true);
      expect(downloader.queuedUrl.has(target)).toBe(true);
    } finally { await downloader.dispose(); }
  });

  test.each([false, true])('later cleanup failures preserve an observer retry admission (workers %s)', async workers => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'repeated-cleanup-retry-'));
    const options = await writeOptions(caseRoot, [
      'concurrency: 1, workerCount: 1,',
      'download: [res => res], processAfterDownload: [res => res], saveToDisk: [res => res],'
    ]);
    const downloader = workers ? new Downloader(options) : new SingleDownloader(options);
    const handleError = jest.spyOn(downloader, 'handleError');
    const url = 'https://example.test/repeated-cleanup.bin';
    const counted = jest.spyOn(downloader.downloadedUrl, 'add');
    const downloadFailure = new Error('download failed');
    const cleanupFailure = new Error('initial cleanup failed');
    const observerFailure = new Error('error observer cleanup failed');
    const dispose = jest.fn<() => void>().mockImplementation(() => { throw cleanupFailure; });
    const observerDispose = jest.fn<() => void>().mockImplementation(() => { throw observerFailure; });
    const observations: unknown[][] = [];
    try {
      await downloader.init;
      const make = (attempt: number) => {
        const resource = downloader.pipeline.createResource(ResourceType.Binary, 0,
          url + '?attempt=' + attempt, url);
        resource.body = 'provided bytes';
        return resource;
      };
      const first = make(1);
      first.meta.doc = {dispose} as unknown as NonNullable<typeof first.meta.doc>;
      const retry = make(2);
      jest.spyOn(downloader.pipeline, 'download').mockRejectedValueOnce(downloadFailure);
      downloader.pipeline.lifeCycle.statusChange = [(_resource, status) => {
        if (status !== 'error') return;
        observations.push(['error', first.meta.error, downloader.queuedUrl.has(url), downloader.downloadedCount]);
        const admitted = downloader.addProcessedResource(retry);
        observations.push(['retry', admitted !== false, downloader.queuedUrl.has(url)]);
        if (first.meta.error === cleanupFailure) {
          first.meta.doc = {dispose: observerDispose} as unknown as NonNullable<typeof first.meta.doc>;
        }
        return Promise.resolve().then(() => {
          observations.push(['settled', downloader.queuedUrl.has(url), downloader.downloadedCount]);
        });
      }];

      downloader.addProcessedResource(first);
      await downloader.onIdle();

      expect(observations).toEqual([
        ['error', downloadFailure, false, 0], ['retry', true, true], ['settled', true, 0],
        ['error', cleanupFailure, true, 0], ['retry', false, true], ['settled', true, 0]
      ]);
      expect(handleError).toHaveBeenCalledTimes(2);
      expect(first.meta.error).toBeInstanceOf(AggregateError);
      expect((first.meta.error as AggregateError).errors).toEqual([cleanupFailure, observerFailure]);
      expect(first.meta.doc).toBeUndefined();
      expect(first.meta.statusChanges).toBeUndefined();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(observerDispose).toHaveBeenCalledTimes(1);
      expect(downloader.downloadedCount).toBe(1);
      expect(first.url).toBe(retry.url);
      expect(counted).toHaveBeenCalledTimes(1);
      expect(counted).toHaveBeenCalledWith(retry.url);
      expect(downloader.downloadedUrl.has(retry.url)).toBe(true);
      expect(downloader.queuedUrl.has(url)).toBe(true);
    } finally { await downloader.dispose(); }
  });

  test.each([
    ['download', false], ['download', true],
    ['cleanup', false], ['cleanup', true],
    ['download-and-cleanup', false], ['download-and-cleanup', true]
  ] as const)('a successful redirect alias survives overlapping %s failure (workers %s)', async (stage, workers) => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'alias-collision-'));
    const options = await writeOptions(caseRoot, [
      'concurrency: 2, workerCount: 1,',
      'download: [res => res], processAfterDownload: [res => res], saveToDisk: [res => res],'
    ]);
    const downloader = workers ? new Downloader(options) : new SingleDownloader(options);
    const handleError = jest.spyOn(downloader, 'handleError');
    const counted = jest.spyOn(downloader.downloadedUrl, 'add');
    const target = 'https://example.test/overlapping-target.bin';
    const downloadFailure = new Error('overlapping download failed');
    const cleanupFailure = new Error('overlapping cleanup failed');
    const observerFailure = new Error('ignored failure observer error');
    const dispose = jest.fn<() => void>().mockImplementation(() => { throw cleanupFailure; });
    const observations: unknown[][] = [];
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
    try {
      await downloader.init;
      const make = (url: string) => {
        const resource = downloader.pipeline.createResource(ResourceType.Binary, 0, url, url);
        resource.body = 'provided bytes';
        return resource;
      };
      const successful = make('https://example.test/redirecting.bin');
      successful.redirectedUrl = target;
      const failed = make(target);
      if (stage !== 'download') failed.meta.doc = {dispose} as unknown as NonNullable<typeof failed.meta.doc>;
      const download = downloader.pipeline.download.bind(downloader.pipeline);
      const downloading = jest.spyOn(downloader.pipeline, 'download').mockImplementation(async resource => {
        if (resource === failed) {
          await failureGate;
          if (stage !== 'cleanup') throw downloadFailure;
        }
        return download(resource);
      });
      downloader.pipeline.lifeCycle.statusChange = [(_resource, status) => {
        if (status !== 'error') return;
        observations.push(['error', failed.meta.error, downloader.queuedUrl.has(target), downloader.downloadedCount]);
        const admitted = downloader.addProcessedResource(make(target));
        observations.push(['retry', admitted !== false, downloader.queuedUrl.has(target)]);
        throw observerFailure;
      }, (_resource, status) => {
        if (status !== 'error') return;
        return Promise.resolve().then(() => {
          observations.push(['settled', downloader.queuedUrl.has(target), downloader.downloadedCount]);
          throw observerFailure;
        });
      }];
      const firstCompleted = new Promise<void>(resolve => {
        downloader.queue.once('completed', () => resolve());
      });
      downloader.addProcessedResource(successful);
      downloader.addProcessedResource(failed);
      await firstCompleted;
      expect(downloader.downloadedCount).toBe(1);
      expect(downloader.downloadedUrl.has(successful.url)).toBe(true);
      expect(downloader.queuedUrl.has(target)).toBe(true);

      releaseFailure();
      await downloader.onIdle();

      const failures = stage === 'download-and-cleanup' ? [downloadFailure, cleanupFailure] :
        [stage === 'download' ? downloadFailure : cleanupFailure];
      expect(observations).toEqual(failures.flatMap(error => [
        ['error', error, true, 1], ['retry', false, true], ['settled', true, 1]
      ]));
      expect(handleError).toHaveBeenCalledTimes(failures.length);
      expect(dispose).toHaveBeenCalledTimes(stage === 'download' ? 0 : 1);
      expect(failed.meta.doc).toBeUndefined();
      expect(failed.meta.statusChanges).toBeUndefined();
      expect(counted).toHaveBeenCalledTimes(1);
      expect(counted).toHaveBeenCalledWith(successful.url);
      expect(downloader.downloadedCount).toBe(1);
      expect(downloader.downloadedUrl.has(failed.url)).toBe(false);
      expect(downloader.queuedUrl.has(target)).toBe(true);
      expect(downloader.addProcessedResource(make(target))).toBe(false);
      expect(downloading).toHaveBeenCalledTimes(2);
    } finally {
      releaseFailure();
      await downloader.dispose();
    }
  });

  test('a failed worker result retains valid discoveries without counting its parent', async () => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'failed-discoveries-'));
    const options = await writeOptions(caseRoot, [
      'concurrency: 1, workerCount: 1,',
      'processAfterDownload: [(resource, submit, _options, pipeline) => {',
      '  if (resource.url.endsWith("/parent.bin")) {',
      '    const child = pipeline.createResource(ResourceType.Binary, 1,',
      '      "https://example.test/child.bin", resource.url);',
      '    child.body = "discovered bytes"; submit(child);',
      '    throw new Error("parent failed after discovery");',
      '  }',
      '  return resource;',
      '}],'
    ]);
    const downloader = new Downloader(options);
    const handleError = jest.spyOn(downloader, 'handleError');
    try {
      await downloader.init;
      const url = 'https://example.test/parent.bin';
      const resource = downloader.pipeline.createResource(ResourceType.Binary, 0, url, url);
      resource.body = 'parent bytes';
      downloader.addProcessedResource(resource);
      await downloader.onIdle();
      expect(handleError).toHaveBeenCalledTimes(1);
      expect(downloader.downloadedCount).toBe(1);
      expect(downloader.downloadedUrl.has(url)).toBe(false);
      expect(downloader.queuedUrl.has(url)).toBe(false);
      expect(downloader.downloadedUrl.has('https://example.test/child.bin')).toBe(true);
      expect(await fs.readFile(path.join(caseRoot, 'example.test/child.bin'), 'utf8')).toBe('discovered bytes');
    } finally { await downloader.dispose(); }
  });

  describe.each([false, true])('terminal streaming counts (workers %s)', workers => {
    test.each([
      ['http-saved', false, 'save', 1, 1],
      ['http-redirect', false, 'redirect', 1, 2],
      ['http-skip-download', false, 'skip-download', 0, 0],
      ['http-skip-save', false, 'skip-save', 1, 1],
      ['http-not-modified', false, '304', 0, 1],
      ['http-failed', false, 'failed', 0, 1],
      ['http-discarded', false, 'discard', 0, 0],
      ['local-copied', true, 'save', 1, 0],
      ['local-skip-download', true, 'skip-download', 0, 0],
      ['local-skip-copy', true, 'skip-save', 0, 0],
      ['local-failed', true, 'failed', 0, 0]
    ] as const)('%s counts completed acquisition after observers settle', async (
      name, local, action, expectedCount, expectedRequests
    ) => {
      const caseRoot = await fs.mkdtemp(path.join(root, 'stream-count-'));
      const bytes = Buffer.from([0x00, 0xff, 0x42, 0xc3, 0xa9]);
      const cached = Buffer.from('preserved cached bytes');
      const source = path.join(caseRoot, 'source.bin');
      const destination = path.join(caseRoot, 'asset.bin');
      const preserve = action === 'skip-download' || action === 'skip-save' || action === '304';
      if (local && action !== 'failed') await fs.writeFile(source, bytes);
      if (preserve) await fs.writeFile(destination, cached);
      let requests = 0;
      const server = createServer((request, response) => {
        ++requests;
        response.setHeader('Connection', 'close');
        if (action === 'redirect' && request.url !== '/target.bin') {
          response.writeHead(302, {location: '/target.bin'});
        } else {
          response.statusCode = action === '304' ? 304 : action === 'failed' ? 500 : 200;
        }
        response.end(bytes);
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
        const url = local ? pathToFileURL(source).href : origin + '/' + name + '.bin';
        const options = await writeOptions(caseRoot, [
          'localSrcRoot: ' + JSON.stringify(caseRoot) + ',',
          'req: {retry: {limit: 0}, throwHttpErrors: true, timeout: {request: 2000}},',
          'processAfterDownload: [() => { throw new Error("Terminal stream reached processing"); }],',
          'saveToDisk: [() => { throw new Error("Terminal stream reached buffered saving"); }],',
          ...(action === 'skip-download' ? ['existingResource: () => "skip",'] : []),
          ...(action === 'skip-save' ? [
            'existingResource: context => context.stage === "saveToDisk" ? "skipSave" : "overwrite",'
          ] : [])
        ]);
        const factory = jest.fn((): never => { throw new Error('Unexpected worker creation'); });
        const downloader = workers ? new Downloader(options, undefined, factory) : new SingleDownloader(options);
        const handleError = jest.spyOn(downloader, 'handleError');
        const observedCounts: number[] = [];
        try {
          await downloader.init;
          downloader.pipeline.lifeCycle.statusChange = [async (_resource, status) => {
            if (status !== 'download') return;
            observedCounts.push(downloader.downloadedCount);
            await Promise.resolve();
            observedCounts.push(downloader.downloadedCount);
          }];
          const resource = downloader.pipeline.createResource(ResourceType.StreamingBinary, 0, url, url);
          resource.savePath = 'asset.bin';
          if (action === 'discard') resource.shouldBeDiscardedFromDownload = true;
          downloader.addProcessedResource(resource);
          await downloader.onIdle();
          expect(downloader.downloadedCount).toBe(expectedCount);
          expect(requests).toBe(expectedRequests);
          expect(handleError).toHaveBeenCalledTimes(action === 'failed' ? 1 : 0);
          expect(observedCounts).toEqual(action === 'failed' ? [] : [0, 0]);
          expect(factory).not.toHaveBeenCalled();
          if (preserve) {
            expect(await fs.readFile(destination)).toEqual(cached);
          } else if (expectedCount) {
            expect(await fs.readFile(destination)).toEqual(bytes);
          } else {
            await expect(fs.readFile(destination)).rejects.toMatchObject({code: 'ENOENT'});
          }
          if (expectedCount) {
            expect(downloader.downloadedUrl.has(url)).toBe(true);
            expect(downloader.addProcessedResource(resource)).toBe(false);
          } else if (action === 'failed') {
            expect(downloader.queuedUrl.has(url)).toBe(false);
          }
          if (action === 'redirect') {
            const target = origin + '/target.bin';
            expect(downloader.queuedUrl.has(target)).toBe(true);
            expect(downloader.addProcessedResource(downloader.pipeline.createResource(
              ResourceType.StreamingBinary, 0, target, url))).toBe(false);
          }
        } finally { await downloader.dispose(); }
        expect(factory).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
    });

    test.each(['copied', 'missing', 'failed'] as const)(
      'mounted stream %s counts only a completed copy', async outcome => {
        const caseRoot = await fs.mkdtemp(path.join(root, 'mounted-count-'));
        const sourceRoot = path.join(caseRoot, 'source');
        const destination = path.join(caseRoot, 'mount.example/asset.bin');
        const bytes = Buffer.from([0x00, 0xff, 0x42, 0x80]);
        await fs.mkdir(sourceRoot);
        if (outcome !== 'missing') await fs.writeFile(path.join(sourceRoot, 'asset.bin'), bytes);
        if (outcome === 'failed') await fs.mkdir(destination, {recursive: true});
        const options = await writeOptions(caseRoot, [
          'download: [localUrlMounts([{root: ' + JSON.stringify(sourceRoot) + ',',
          '  urlPrefix: "https://mount.example/", notFound: "discard"}])],',
          'processAfterDownload: [() => { throw new Error("Mounted stream reached processing"); }],'
        ], [
          'import {localUrlMounts} from ' + JSON.stringify(pathToFileURL(
            path.join(buildRoot, 'life-cycle/local-url-mount.js')).href) + ';'
        ]);
        const factory = jest.fn((): never => { throw new Error('Unexpected worker creation'); });
        const downloader = workers ? new Downloader(options, undefined, factory) : new SingleDownloader(options);
        const handleError = jest.spyOn(downloader, 'handleError');
        try {
          await downloader.init;
          const url = 'https://mount.example/asset.bin';
          const resource = downloader.pipeline.createResource(ResourceType.StreamingBinary, 0, url, url);
          downloader.addProcessedResource(resource);
          await downloader.onIdle();
          expect(downloader.downloadedCount).toBe(outcome === 'copied' ? 1 : 0);
          expect(handleError).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
          expect(factory).not.toHaveBeenCalled();
          if (outcome === 'copied') {
            expect(await fs.readFile(destination)).toEqual(bytes);
            expect(downloader.downloadedUrl.has(url)).toBe(true);
            expect(downloader.addProcessedResource(resource)).toBe(false);
          } else if (outcome === 'missing') {
            await expect(fs.readFile(destination)).rejects.toMatchObject({code: 'ENOENT'});
          } else {
            expect((await fs.stat(destination)).isDirectory()).toBe(true);
            expect(downloader.queuedUrl.has(url)).toBe(false);
          }
        } finally { await downloader.dispose(); }
        expect(factory).not.toHaveBeenCalled();
      });
  });

  test('initialization and streaming downloads do not create workers', async () => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'stream-'));
    const bytes = Buffer.from([0xff, 0x00, 0x80, 0x42]);
    const server = createServer((_request, response) => {
      response.setHeader('Connection', 'close');
      response.end(bytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/stream.bin';
    const options = await writeOptions(caseRoot, [
      'detectResourceType: [() => ResourceType.StreamingBinary],',
      'req: {retry: {limit: 0}, timeout: {request: 2000}},'
    ]);
    const factory = jest.fn((): never => { throw new Error('Unexpected worker creation'); });
    const downloader = new Downloader(options, undefined, factory);
    const handleError = jest.spyOn(downloader, 'handleError');
    try {
      await downloader.init;
      expect(factory).not.toHaveBeenCalled();
      await downloader.addInitialResource([url]);
      downloader.start();
      await downloader.onIdle();
      expect(handleError).not.toHaveBeenCalled();
      expect(downloader.downloadedCount).toBe(1);
      expect(await fs.readFile(path.join(caseRoot, '127.0.0.1/stream.bin'))).toEqual(bytes);
      await downloader.dispose();
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await downloader.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });

  test('dispose before initialization is idempotent and creates no workers', async () => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'dispose-early-'));
    const options = await writeOptions(caseRoot, []);
    const factory = jest.fn((): never => { throw new Error('Unexpected worker creation'); });
    const downloader = new Downloader(options, undefined, factory);
    const disposal = downloader.dispose();
    expect(downloader.dispose()).toBe(disposal);
    await disposal;
    expect(factory).not.toHaveBeenCalled();
  });

  test.each([
    [false, false], [false, true], [true, false], [true, true]
  ])('initialized disposal hooks can re-enter once (workers %s, failure %s)', async (workers, failure) => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'dispose-reentrant-'));
    const options = await writeOptions(caseRoot, []);
    const factory = jest.fn((): never => { throw new Error('Unexpected worker creation'); });
    const downloader = workers ? new Downloader(options, undefined, factory) : new SingleDownloader(options);
    const error = new Error('dispose hook failed');
    const reentered: Promise<void>[] = [];
    let calls = 0;
    try {
      await downloader.init;
      downloader.pipeline.lifeCycle.dispose = [() => {
        if (++calls === 1) {
          const repeated = downloader.dispose();
          void repeated.catch(() => undefined);
          reentered.push(repeated);
        }
        if (failure) throw error;
      }];
      const disposal = downloader.dispose();
      if (failure) await expect(disposal).rejects.toBe(error);
      else await disposal;
      expect(calls).toBe(1);
      expect(reentered).toEqual([disposal]);
      expect(reentered[0]).toBe(disposal);
      expect(downloader.dispose()).toBe(disposal);
      expect(factory).not.toHaveBeenCalled();
    } finally { await downloader.dispose().catch(() => undefined); }
  });

  test.each([false, true])('idle disposal awaits a replaced pipeline cleanup and permits reentry (failure %s)', async failure => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'dispose-replaced-'));
    const options = await writeOptions(caseRoot, []);
    const downloader = new SingleDownloader(options);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const error = new Error('replacement cleanup failed');
    let repeated: Promise<void> | undefined;
    let calls = 0;
    try {
      await downloader.init;
      expect(downloader.pipeline.lifeCycle.dispose).toHaveLength(0);
      downloader.pipeline.dispose = async () => {
        calls++;
        repeated = downloader.dispose();
        void repeated.catch(() => undefined);
        await waiting;
        if (failure) throw error;
      };
      const disposal = downloader.dispose();
      let settled = false;
      void disposal.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      expect(calls).toBe(1);
      expect(repeated).toBe(disposal);
      expect(settled).toBe(false);
      release();
      if (failure) await expect(disposal).rejects.toBe(error);
      else await disposal;
      expect(downloader.dispose()).toBe(disposal);
      expect(calls).toBe(1);
    } finally {
      release();
      await downloader.dispose().catch(() => undefined);
    }
  });

  test.each([false, true])('worker URL logs are safe and local only when workerSafe=%s', async workerSafe => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'logger-'));
    const logPath = path.join(caseRoot, 'events.jsonl');
    const options = await writeOptions(caseRoot, [
      'download: [res => res], saveToDisk: [res => res],',
      'processAfterDownload: [res => {',
      '  getLogger().info("custom.worker", new URL(res.url), res.uri); return res;',
      '}],',
      'createLogger: () => {',
      '  record({event: "factory"});',
      '  return {workerSafe: ' + workerSafe + ',',
      '    trace() {}, debug() {}, warn() {}, error() {}, isTraceEnabled: () => false,',
      '    info(type, ...args) { if (type === "custom.worker") record({event: "log", args}); }',
      '  };',
      '},',
      'concurrency: 1, workerCount: 1,'
    ], [
      'import {appendFileSync} from "node:fs";',
      'import {threadId} from "node:worker_threads";',
      'const record = event => appendFileSync(' + JSON.stringify(logPath) +
        ', JSON.stringify({...event, threadId}) + "\\n");'
    ]);
    const downloader = new Downloader(options);
    const handleError = jest.spyOn(downloader, 'handleError');
    try {
      await downloader.init;
      const url = 'https://example.test/log.bin';
      const resource = downloader.pipeline.createResource(ResourceType.Binary, 0, url, url);
      resource.body = 'test';
      downloader.addProcessedResource(resource);
      await downloader.onIdle();
      await downloader.dispose();
      expect(handleError).not.toHaveBeenCalled();
      const events = (await fs.readFile(logPath, 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as {event: string; threadId: number; args?: unknown[]});
      expect(events.filter(event => event.event === 'factory')).toHaveLength(workerSafe ? 2 : 1);
      const logs = events.filter(event => event.event === 'log');
      expect(logs).toHaveLength(1);
      expect(logs[0].threadId > 0).toBe(workerSafe);
      expect(logs[0].args?.slice(-2)).toEqual([url, url]);
    } finally { await downloader.dispose(); }
  });

  test('owned and partial buffers preserve exact bytes and the source wrapper', async () => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'buffers-'));
    const logPath = path.join(caseRoot, 'bytes.jsonl');
    const options = await writeOptions(caseRoot, [
      'download: [res => res], saveToDisk: [res => res],',
      'processAfterDownload: [res => {',
      '  record({bytes: [...res.body], buffer: Buffer.isBuffer(res.body), url: res.uri.toString()});',
      '  return res;',
      '}],'
    ], [
      'import {appendFileSync} from "node:fs";',
      'const record = event => appendFileSync(' + JSON.stringify(logPath) + ', JSON.stringify(event) + "\\n");'
    ]);
    const downloader = new Downloader(options);
    const handleError = jest.spyOn(downloader, 'handleError');
    try {
      await downloader.init;
      const bodies = [Buffer.alloc(4, 0xfe), Buffer.from([1, 2, 0xff, 0, 0x80, 3]).subarray(1, 5)];
      const resources = bodies.map((body, index) => {
        const url = 'https://example.test/body' + index + '.bin';
        const resource = downloader.pipeline.createResource(ResourceType.Binary, 0, url, url);
        resource.body = body;
        return {resource, body, bytes: [...body]};
      });
      for (const {resource} of resources) downloader.addProcessedResource(resource);
      await downloader.onIdle();
      expect(handleError).not.toHaveBeenCalled();
      const events = (await fs.readFile(logPath, 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as {url: string; bytes: number[]; buffer: boolean});
      for (const {resource, body, bytes} of resources) {
        expect(resource.body).toBe(body);
        expect(events.find(event => event.url === resource.url)).toEqual({url: resource.url, bytes, buffer: true});
      }
    } finally { await downloader.dispose(); }
  });

  test.each([false, true])('terminal replacement documents are released once (workers %s)', async workers => {
    const caseRoot = await fs.mkdtemp(path.join(root, 'documents-'));
    const logPath = path.join(caseRoot, 'documents.jsonl');
    const options = await writeOptions(caseRoot, [
      'download: [res => res],',
      'loadHtml(content, options, isDocument) {',
      '  const doc = parseHtml(content, options, isDocument);',
      '  doc.dispose = () => record("dispose"); return doc;',
      '},',
      'processAfterDownload: [...defaultLifeCycle().processAfterDownload,',
      '  res => ({...res, meta: {...res.meta}})],',
      'saveToDisk: [res => ({...res, meta: {...res.meta}})],',
      'statusChange: [(_res, status) => {',
      '  if (status === "saveToDisk") return Promise.resolve().then(() => record("status"));',
      '}],'
    ], [
      'import {load as parseHtml} from "cheerio";',
      'import {appendFileSync} from "node:fs";',
      'const record = event => appendFileSync(' + JSON.stringify(logPath) + ', JSON.stringify(event) + "\\n");'
    ]);
    const downloader = workers ? new Downloader(options) : new SingleDownloader(options);
    const handleError = jest.spyOn(downloader, 'handleError');
    try {
      await downloader.init;
      const url = 'https://example.test/document.html';
      const resource = downloader.pipeline.createResource(ResourceType.Html, 0, url, url);
      resource.body = '<html><body>document</body></html>';
      downloader.addProcessedResource(resource);
      await downloader.onIdle();
      await downloader.dispose();
      expect(handleError).not.toHaveBeenCalled();
      expect((await fs.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)))
        .toEqual(['status', 'dispose']);
      expect(resource.meta.doc).toBeUndefined();
    } finally { await downloader.dispose(); }
  });

  test.each([false, true])(
    'worker discoveries deduplicate before cloning and retain admission and cleanup (strip search %s)',
    async stripSearch => {
      const caseRoot = await fs.mkdtemp(path.join(root, 'discoveries-'));
      const logPath = path.join(caseRoot, 'documents.jsonl');
      const options = await writeOptions(caseRoot, [
        'concurrency: 1, workerCount: 1, maxDepth: 1, deduplicateStripSearch: ' + stripSearch + ',',
        'processAfterDownload: [(res, submit, options, pipeline) => {',
        '  const make = (path, id, depth = 1) => {',
        '    const child = pipeline.createResource(ResourceType.Binary, depth,',
        '      "https://example.test/" + path, res.url); child.meta.id = id; return child;',
        '  };',
        '  const discarded = make("child?one#discarded", "discarded");',
        '  discarded.shouldBeDiscardedFromDownload = true;',
        '  discarded.meta.doc = {dispose: () => record("discarded")};',
        '  submit(discarded);',
        '  submit(make("depth", "deep", 2)); submit(make("depth", "shallow"));',
        '  submit(make("child?one#first", "first"));',
        '  const duplicate = make("child?one#second", "duplicate");',
        '  duplicate.meta.unused = () => {};',
        '  duplicate.meta.doc = {dispose: () => record("duplicate")};',
        '  submit(duplicate);',
        '  const query = make("child?two#third", "query");',
        '  if (options.deduplicateStripSearch) query.meta.unused = () => {};',
        '  submit(query);',
        '  const bodyful = make("child?one#body", "bodyful");',
        '  bodyful.body = "already downloaded"; submit(bodyful);',
        '  try { submit(Object.defineProperty(make("fixed", "broken"), "bad",',
        '    {enumerable: true, get() { throw new Error("repairable"); }})); } catch {}',
        '  submit(make("fixed", "corrected")); return res;',
        '}],',
        'saveToDisk: [res => {record("saved"); return res;}],'
      ], [
        'import {appendFileSync} from "node:fs";',
        'const record = event => appendFileSync(' + JSON.stringify(logPath) + ', JSON.stringify(event) + "\\n");'
      ]);
      const downloader = new Downloader(options);
      try {
        await downloader.init;
        for (let task = 0; task < 2; task++) {
          const url = 'https://example.test/parent' + task;
          const resource = downloader.pipeline.createResource(ResourceType.Binary, 0, url, url);
          resource.body = 'parent';
          const message = await downloader.pool.submitTask(prepareResourceForClone(resource));
          expect(message.error).toBeUndefined();
          expect(message.body.map(child => child.meta.id)).toEqual([
            'deep', 'shallow', 'first', ...(stripSearch ? [] : ['query']), 'bodyful', 'corrected'
          ]);
          expect(message.body.slice(0, 2).map(child => child.depth)).toEqual([2, 1]);
          expect(message.body.find(child => child.meta.id === 'bodyful')?.body).toBe('already downloaded');
          expect(message.body.every(child => child.meta.doc === undefined)).toBe(true);
        }
        expect((await fs.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)))
          .toEqual(['saved', 'discarded', 'duplicate', 'saved', 'discarded', 'duplicate']);
      } finally { await downloader.dispose(); }
    });

  test.each([false, true])(
    'downloads and processes resources in a real worker (overrides: %s)',
    async withOverrides => {
      const caseRoot = await fs.mkdtemp(path.join(root, 'case-'));
      const requests: IncomingHttpHeaders[] = [];
      const bytes = Buffer.from([0xff, 0x00, 0x80, 0x42]);
      const server = createServer((request, response) => {
        requests.push(request.headers);
        response.setHeader('Connection', 'close');
        if (request.url === '/image.bin') {
          response.end(bytes);
        } else {
          response.end('<html><body><img src="/image.bin"></body></html>');
        }
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = 'http://127.0.0.1:' +
        (server.address() as AddressInfo).port + '/index.html';
      const optionsPath = path.join(caseRoot, 'options.mjs');
      const optionsUrl = pathToFileURL(path.join(buildRoot, 'options.js')).href;
      const lifeCycleUrl = pathToFileURL(
        path.join(buildRoot, 'life-cycle/default-life-cycle.js')).href;
      const resourceUrl = pathToFileURL(path.join(buildRoot, 'resource.js')).href;
      await fs.writeFile(optionsPath, [
        'import {isMainThread} from "node:worker_threads";',
        'import {defaultDownloadOptions} from ' + JSON.stringify(optionsUrl) + ';',
        'import {defaultLifeCycle} from ' + JSON.stringify(lifeCycleUrl) + ';',
        'import {ResourceType} from ' + JSON.stringify(resourceUrl) + ';',
        'const lc = defaultLifeCycle();',
        'lc.processAfterDownload.push((res, submit, options, pipeline) => {',
        '  if (res.type === ResourceType.Html) {',
        '    const body = res.meta.doc("body");',
        '    body.attr("data-worker", isMainThread ? "main" : "worker");',
        '    body.attr("data-label", options.meta.label);',
        '    body.attr("data-extra", pipeline.requestOptions.headers["x-extra"] || "none");',
        '  }',
        '  return res;',
        '});',
        'export default defaultDownloadOptions({',
        '  ...lc, concurrency: 1, workerCount: 1,',
        '  initialUrl: [' + JSON.stringify(url) + '],',
        '  localRoot: ' + JSON.stringify(path.join(caseRoot, 'default')) + ',',
        '  meta: {label: "module"},',
        '  req: {headers: {"x-base": "module"}, retry: {limit: 0},',
        '    timeout: {request: 2000},',
        '    hooks: {beforeRequest: [options => {options.headers["x-hook"] = "hook";}]}',
        '  },',
        '  createLogger: () => ({',
        '    trace() {}, debug() {}, info() {}, warn() {}, error() {},',
        '    isTraceEnabled: () => false',
        '  })',
        '});'
      ].join('\n'));
      const overrides = withOverrides ? {
        localRoot: path.join(caseRoot, 'override'),
        meta: {label: 'override'},
        req: {headers: {'x-extra': 'override'}, retry: {limit: 0}}
      } : undefined;
      const originalOverrides = structuredClone(overrides);
      const downloader = new Downloader(pathToFileURL(optionsPath).href, overrides);
      const handleError = jest.spyOn(downloader, 'handleError');
      try {
        await downloader.init;
        downloader.start();
        await downloader.onIdle();

        expect(handleError).not.toHaveBeenCalled();
        expect(downloader.downloadedCount).toBe(2);
        expect(requests).toHaveLength(2);
        for (const headers of requests) {
          expect(headers['x-base']).toBe('module');
          expect(headers['x-hook']).toBe('hook');
          expect(headers['x-extra']).toBe(withOverrides ? 'override' : undefined);
        }
        const outputRoot = path.join(downloader.options.localRoot, '127.0.0.1');
        const html = await fs.readFile(path.join(outputRoot, 'index.html'), 'utf8');
        expect(html).toContain('data-worker="worker"');
        expect(html).toContain('data-label="' + (withOverrides ? 'override' : 'module') + '"');
        expect(html).toContain('data-extra="' + (withOverrides ? 'override' : 'none') + '"');
        expect(await fs.readFile(path.join(outputRoot, 'image.bin'))).toEqual(bytes);
        expect(overrides).toEqual(originalOverrides);
      } finally {
        try {
          await downloader.dispose();
        } finally {
          await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
          });
        }
      }
    }, 15000);
});

test.each([false, true])('submitted child bytes survive parent saving (workers %s)', async workers => {
  const caseRoot = await fs.mkdtemp(path.join(root, 'submitted-bytes-'));
  const options = await writeOptions(caseRoot, [
    'concurrency: 1, workerCount: 1, download: [res => res],',
    'processAfterDownload: [(res, submit, options, pipeline) => {',
    '  if (res.depth) return res;',
    '  const bodies = [res.body, res.body.subarray(1, 3),',
    '    new DataView(res.body.buffer, res.body.byteOffset + 1, 2), res.body.buffer];',
    '  const children = bodies.map((body, index) => {',
    '    const child = pipeline.createResource(ResourceType.Binary, 1,',
    '      "https://example.test/child" + index, res.url);',
    '    child.body = body; return child;',
    '  });',
    '  submit(children[0]); submit(children.slice(1));',
    '  res.body.fill(9);',
    '  return res;',
    '}],'
  ]);
  const downloader = workers ? new Downloader(options) : new SingleDownloader(options);
  const handleError = jest.spyOn(downloader, 'handleError');
  try {
    await downloader.init;
    const url = 'https://example.test/parent';
    const parent = downloader.pipeline.createResource(ResourceType.Binary, 0, url, url);
    const body = Buffer.allocUnsafeSlow(4);
    body.set([1, 2, 3, 4]);
    parent.body = body;
    downloader.addProcessedResource(parent);
    await downloader.onIdle();
    expect(handleError).not.toHaveBeenCalled();
    expect(downloader.downloadedCount).toBe(5);
    expect(await fs.readFile(path.join(caseRoot, 'example.test/parent'))).toEqual(Buffer.alloc(4, 9));
    for (let index = 0; index < 4; index++) {
      expect(await fs.readFile(path.join(caseRoot, 'example.test/child' + index)))
        .toEqual(Buffer.from(index === 1 || index === 2 ? [2, 3] : [1, 2, 3, 4]));
    }
  } finally { await downloader.dispose(); }
});
