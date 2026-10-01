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
import {ResourceType} from '../../src/resource.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
let root: string;
let buildRoot: string;
let Downloader: typeof MultiThreadDownloader;

beforeAll(async () => {
  // Native workers need emitted JS, including when npm test runs before a build.
  root = await fs.mkdtemp(path.join(projectRoot, '.wse-worker-test-'));
  buildRoot = path.join(root, 'lib');
  await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'node_modules/typescript/bin/tsc'),
    '--project', path.join(projectRoot, 'tsconfig.json'),
    '--outDir', buildRoot,
    '--declaration', 'false',
    '--declarationMap', 'false',
    '--sourceMap', 'false'
  ], {cwd: projectRoot, timeout: 30000});
  const module = await import(pathToFileURL(
    path.join(buildRoot, 'downloader/multi.js')).href);
  Downloader = module.MultiThreadDownloader;
}, 30000);

afterAll(async () => {
  if (root) await fs.rm(root, {recursive: true, force: true});
});

describe('MultiThreadDownloader', () => {
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
        'lc.download.unshift(res => {',
        '  res.meta.transport = {nested: [1, {value: "preserved"}]};',
        '  return res;',
        '});',
        'lc.processAfterDownload.push((res, submit, options, pipeline) => {',
        '  if (res.uri.clone().toString() !== res.url ||',
        '      res.refUri.clone().toString() !== res.refUrl ||',
        '      res.replaceUri.clone().toString() !== res.replacePath ||',
        '      res.meta.transport.nested[1].value !== "preserved") {',
        '    throw new Error("Worker resource transport lost runtime invariants");',
        '  }',
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
        const submit = jest.spyOn(downloader.pool, 'submitTask');
        downloader.start();
        await downloader.onIdle();

        expect(handleError).not.toHaveBeenCalled();
        expect(downloader.downloadedCount).toBe(2);
        expect(requests).toHaveLength(2);
        expect(submit).toHaveBeenCalledTimes(2);
        for (const [wire] of submit.mock.calls) {
          for (const field of ['uri', 'refUri', 'replaceUri', 'host']) {
            expect(wire).not.toHaveProperty(field);
          }
          expect(wire.meta).not.toHaveProperty('doc');
        }
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

test('explicit lifecycle and crawl isolation in real Node processes', async () => {
  await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'test/runtime-lifecycle.js'),
    path.join(buildRoot, 'index.js')
  ], {cwd: projectRoot, timeout: 35000});
}, 40000);

test('failed downloads, processing, and saves can be retried in both modes', async () => {
  await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'test/runtime-failure-retry.js'),
    path.join(buildRoot, 'index.js')
  ], {cwd: projectRoot, timeout: 35000});
}, 40000);


test('resource outcomes agree across buffered, streaming, local and worker paths', async () => {
  await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'test/runtime-outcomes.js'),
    path.join(buildRoot, 'index.js')
  ], {cwd: projectRoot, timeout: 50000});
}, 55000);


test.each([
  {publishedFiles: -1, skipped: false},
  {publishedFiles: Infinity, skipped: false},
  {publishedFiles: 0, skipped: 'false'}
])('rejects invalid worker publication metadata: %j', async progress => {
  const crawler = new Downloader(pathToFileURL(path.join(projectRoot,
    'test/downloader/budget-options.js')).href,
  {concurrency: 1, workerCount: 1, localRoot: root});
  try {
    await crawler.init;
    jest.spyOn(crawler.pool, 'submitTask').mockResolvedValue({version: 1,
      taskId: 1, type: 1, body: [], progress} as never);
    const url = 'https://example.test/invalid-progress';
    const resource = await crawler.pipeline.createResource(ResourceType.Binary, 0, url, url);
    if (!resource) throw new Error('Resource was discarded');
    resource.body = Buffer.from('body');
    expect(crawler.addProcessedResource(resource)).toBe(true);
    await crawler.start();
    await crawler.onIdle();
    expect(resource.meta.error).toMatchObject({message: 'Worker result.progress is invalid'});
    expect(crawler.outcomes.get(url)).toMatchObject({status: 'failed', publishedFiles: 0});
    expect(crawler.downloadedCount).toBe(0);
  } finally { await crawler.dispose(); }
}, 10000);


test('parent owns worker staging cleanup and publication after worker failure', async () => {
  await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'test/runtime-parent-publication.js'),
    path.join(buildRoot, 'index.js')
  ], {cwd: projectRoot, timeout: 35000});
}, 40000);

test('destination ownership prevents silent overwrites in both downloader modes', async () => {
  await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'test/runtime-output-conflicts.js'),
    path.join(buildRoot, 'index.js')
  ], {cwd: projectRoot, timeout: 35000});
}, 40000);

test('discovery limits preserve earlier children when their parent fails in both modes', async () => {
  await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'test/runtime-discovery.js'),
    path.join(buildRoot, 'index.js')
  ], {cwd: projectRoot, timeout: 35000});
}, 40000);

test('automatic adjustment backs off while an HTTP origin is stalled in both modes', async () => {
  await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'test/runtime-adjustment.js'),
    path.join(buildRoot, 'index.js')
  ], {cwd: projectRoot, timeout: 35000});
}, 40000);

test('aggregate body reservations bound admission, processing and worker discovery', async () => {
  await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'test/runtime-buffer-budget.js'),
    path.join(buildRoot, 'index.js')
  ], {cwd: projectRoot, timeout: 50000});
}, 55000);

test('oversized custom-worker discovery batches reject before decoding children', async () => {
  const crawler = new Downloader(pathToFileURL(path.join(projectRoot,
    'test/downloader/budget-options.js')).href,
  {concurrency: 1, workerCount: 1, localRoot: root, maxDiscoveredResources: 1});
  try {
    await crawler.init;
    jest.spyOn(crawler.pool, 'submitTask').mockResolvedValue({version: 1,
      taskId: 1, type: 1, body: [null, null]} as never);
    const url = 'https://example.test/oversized-discovery';
    const resource = await crawler.pipeline.createResource(ResourceType.Binary, 0, url, url);
    if (!resource) throw new Error('Resource was discarded');
    resource.body = Buffer.from('body');
    expect(crawler.addProcessedResource(resource)).toBe(true);
    await crawler.start();
    await crawler.onIdle();
    expect(resource.meta.error).toMatchObject({code: 'ERR_DISCOVERY_LIMIT', limit: 1, actual: 2});
    expect(crawler.outcomes.size).toBe(1);
    expect(crawler.outcomes.get(url)?.status).toBe('failed');
  } finally { await crawler.dispose(); }
}, 10000);
