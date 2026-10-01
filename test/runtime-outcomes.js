import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
const {downloader, resource} = await import(entry);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-outcomes-'));
const requests = new Map();
const server = createServer((request, response) => {
  requests.set(request.url, (requests.get(request.url) ?? 0) + 1);
  response.setHeader('Connection', 'close');
  if (request.url.startsWith('/redirect-')) {
    response.writeHead(302, {location: '/target'});
  } else if (request.url.startsWith('/not-modified')) {
    response.statusCode = 304;
  } else if (request.url === '/stream-failed') {
    response.statusCode = 500;
  }
  response.end('body');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const source = path.join(root, 'source.bin');
await fs.writeFile(source, 'body');
const cases = [
  ['buffered', false, 'saved', true, 1],
  ['concurrent', false, 'saved', true, 1],
  ['streamed', true, 'saved', true, 1],
  ['local-buffered', false, 'saved', true, 1],
  ['local-streamed', true, 'saved', true, 1],
  ['skip-buffered', false, 'skipped', false, 0],
  ['skip-streamed', true, 'skipped', false, 0],
  ['skip-save-buffered', false, 'skipped', true, 0],
  ['skip-save-streamed', true, 'skipped', true, 0],
  ['not-modified-buffered', false, 'skipped', false, 0],
  ['not-modified-streamed', true, 'skipped', false, 0],
  ['redirect-buffered', false, 'saved', true, 2],
  ['redirect-streamed', true, 'saved', true, 1],
  ['process-handled', false, 'processed', true, 0],
  ['process-failed', false, 'failed', true, 0],
  ['partial-failure', false, 'failed', true, 1],
  ['stream-failed', true, 'failed', false, 0],
  ['empty-body', false, 'saved', true, 1],
  ['cancelled', false, 'cancelled', false, 0],
  ['cancel-active', false, 'cancelled', true, 0]
];
const deadline = setTimeout(() => { throw new Error('Outcome checks timed out'); }, 45000);
deadline.unref();
try {
  for (const Downloader of [downloader.SingleThreadDownloader, downloader.MultiThreadDownloader]) {
    for (const [name, streaming, status, downloaded, publishedFiles] of cases) {
      const output = path.join(root, Downloader.name, name);
      await fs.mkdir(output, {recursive: true});
      const cached = name.startsWith('skip-') || name.startsWith('not-modified');
      if (cached) await fs.writeFile(path.join(output, 'asset.bin'), 'cached');
      const config = path.join(output, 'options.mjs');
      await fs.writeFile(config, `
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {lifeCycle, options, io} from ${JSON.stringify(entry)};
const name = ${JSON.stringify(name)};
const lc = lifeCycle.defaultLifeCycle();
if (name.startsWith('skip-save')) lc.existingResource = ctx => ctx.stage === 'saveToDisk' ? 'skipSave' : 'overwrite';
else if (name.startsWith('skip-')) lc.existingResource = () => 'skip';
if (name === 'concurrent') lc.processAfterDownload.unshift(async res => {
  await new Promise(resolve => setTimeout(resolve, res.url.endsWith('/bad') ? 40 : 1));
  if (res.url.endsWith('/bad')) throw new Error('concurrent failure');
  return res;
});
if (name === 'cancel-active') lc.processAfterDownload.unshift(async (res, submit, opt, pipeline) => {
  await fs.writeFile(path.join(opt.localRoot, 'started'), 'ready');
  await new Promise(resolve => {
    if (pipeline.signal.aborted) resolve();
    else pipeline.signal.addEventListener('abort', resolve, {once: true});
  });
  return res;
});
if (name === 'process-handled') lc.processAfterDownload.unshift(() => undefined);
if (name === 'process-failed') lc.processAfterDownload.unshift(() => { throw new Error('processing failed'); });
if (name === 'partial-failure') lc.saveToDisk.unshift(async res => {
  await io.writeFile(path.join(res.localRoot, 'partial.bin'), res.body, res.encoding,
    undefined, undefined, res.localRoot);
  throw new Error('failed after one publication');
});
if (name === 'stream-failed') lc.download = lc.download.map(handler =>
  handler === lifeCycle.downloadStreamingResource ? lifeCycle.downloadStreamingResourceWithHook(undefined,
    () => fs.writeFile(${JSON.stringify(path.join(output, 'after'))}, 'unexpected'),
    () => fs.writeFile(${JSON.stringify(path.join(output, 'error'))}, 'observed')) : handler);
export default options.defaultDownloadOptions({...lc, localRoot: ${JSON.stringify(output)},
  initialUrl: [], concurrency: 2, workerCount: 1,
  req: {retry: {limit: 0}, timeout: {request: 2000}},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
      const crawler = new Downloader(pathToFileURL(config).href);
      const url = name.startsWith('local-') ? pathToFileURL(source).href : base + '/' + name;
      const res = resource.createResource({type: streaming ? resource.ResourceType.StreamingBinary :
        resource.ResourceType.Binary, url, refUrl: url, depth: 0, localRoot: output,
      savePath: 'asset.bin', refSavePath: 'source.bin', localSrcRoot: root, encoding: null});
      if (name === 'empty-body') res.body = '';
      const beforeRequests = requests.get('/' + name) ?? 0;
      try {
        await crawler.init;
        assert.equal(crawler.addProcessedResource(res), true);
        if (name === 'concurrent') {
          const other = resource.createResource({type: resource.ResourceType.Binary,
            depth: 0, url: url + '/bad', refUrl: url, localRoot: output, savePath: 'bad.bin'});
          assert.equal(crawler.addProcessedResource(other), true);
        }
        const queued = crawler.outcomes.get(url);
        assert.equal(queued.status, 'queued');
        assert.equal(queued.attempt, 1);
        if (name === 'cancelled') await crawler.dispose();
        else {
          await crawler.start();
          if (name === 'cancel-active') {
            const readyDeadline = Date.now() + 5000;
            while (!await fs.stat(path.join(output, 'started')).then(() => true, () => false)) {
              if (Date.now() > readyDeadline) throw new Error('Active hook did not start');
              await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.equal(crawler.outcomes.get(url).status, 'running');
            await crawler.dispose();
          }
          await crawler.onIdle();
        }
        const outcome = crawler.outcomes.get(url);
        assert.deepEqual(outcome, {status, attempt: 1, url, downloaded, publishedFiles},
          `${Downloader.name}/${name}`);
        assert.equal(queued.status, 'queued', 'previous outcome snapshots remain unchanged');
        assert.equal(crawler.downloadedCount, downloaded && status !== 'failed' && status !== 'cancelled' ? 1 : 0);
        if (name === 'concurrent') {
          assert.deepEqual(crawler.outcomes.get(url + '/bad'), {status: 'failed', attempt: 1,
            url: url + '/bad', downloaded: true, publishedFiles: 0});
        }
        if (name === 'stream-failed') {
          assert.ok(res.meta.error);
          assert.equal(await fs.readFile(path.join(output, 'error'), 'utf8'), 'observed');
          await assert.rejects(fs.stat(path.join(output, 'after')), {code: 'ENOENT'});
        }
        if (cached) assert.equal(await fs.readFile(path.join(output, 'asset.bin'), 'utf8'), 'cached');
        if (status === 'saved') {
          assert.equal(await fs.readFile(path.join(output, 'asset.bin'), 'utf8'), name === 'empty-body' ? '' : 'body');
        }
        if (name.startsWith('redirect-')) {
          assert.equal(crawler.queuedUrl.has(base + '/target'), true);
        }
        if (name === 'empty-body' || name === 'cancelled' || name === 'skip-buffered' || name === 'skip-streamed') {
          assert.equal(requests.get('/' + name) ?? 0, beforeRequests, 'no request for skipped/provided content');
        }
      } finally { await crawler.dispose(); }
    }
  }
  console.log(`${process.version}: ${cases.length * 2} resource outcome scenarios passed`);
} finally {
  clearTimeout(deadline);
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fs.rm(root, {recursive: true, force: true});
}
