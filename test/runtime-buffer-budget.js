import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
const {downloader, resource} = await import(entry);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-buffer-budget-'));
const server = createServer((request, response) => {
  response.setHeader('Connection', 'close');
  response.end(request.url === '/small.bin' ? 'small' : 'elevenbytes');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const source = path.join(root, 'source.bin');
await fs.writeFile(source, 'elevenbytes');
const deadline = setTimeout(() => { throw new Error('Buffer budget checks timed out'); }, 45000);
deadline.unref();
try {
  for (const Downloader of [downloader.SingleThreadDownloader, downloader.MultiThreadDownloader]) {
    for (const mode of ['queued', 'children', 'child-overflow', 'duplicate', 'queue-rejected',
      'transform', 'http', 'local', 'stream', 'generated', 'cancel', 'concurrent']) {
      const output = path.join(root, Downloader.name, mode);
      await fs.mkdir(output, {recursive: true});
      const config = path.join(output, 'options.mjs');
      await fs.writeFile(config, `
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {lifeCycle, options, resource, io} from ${JSON.stringify(entry)};
const lc = lifeCycle.defaultLifeCycle();
lc.processAfterDownload.unshift(async (res, submit, opt, pipeline) => {
  if (!res.url.endsWith('/parent.bin')) return res;
  if (${JSON.stringify(mode)} === 'cancel') {
    await new Promise(resolve => {
      if (pipeline.signal.aborted) resolve();
      else pipeline.signal.addEventListener('abort', resolve, {once: true});
    });
    return res;
  }
  if (${JSON.stringify(mode)} === 'transform' && !res.meta.retry) return {...res, body: Buffer.alloc(11)};
  if (${JSON.stringify(mode)} === 'concurrent') {
    while (!await fs.stat(path.join(res.localRoot, 'release')).then(() => true, () => false)) {
      pipeline.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  if (['children', 'child-overflow', 'duplicate', 'queue-rejected'].includes(${JSON.stringify(mode)})) {
    const make = (id, bytes) => ({...resource.createResource({type: resource.ResourceType.Binary,
      depth: 1, url: ${JSON.stringify(origin)} + '/child-' + id + '.bin', refUrl: res.url,
      localRoot: res.localRoot}), body: Buffer.alloc(bytes, 97)});
    submit(make(1, ${mode === 'child-overflow' ? 6 : 3}));
    submit(make(${mode === 'duplicate' ? 1 : 2}, ${mode === 'child-overflow' ? 1 : 3}));
  }
  return res;
});
if (${JSON.stringify(mode)} === 'generated') lc.saveToDisk = [async res => {
  await io.writeFile(path.join(res.localRoot, 'generated.bin'), Buffer.alloc(11), null,
    undefined, undefined, res.localRoot);
  return res;
}];
export default options.defaultDownloadOptions({...lc, initialUrl: [], maxDepth: 2,
  localRoot: ${JSON.stringify(output)}, concurrency: ${mode === 'concurrent' ? 2 : 1}, workerCount: 1,
  maxBufferedBytes: 10, maxQueuedResources: ${mode === 'queue-rejected' ? 1 : 'undefined'},
  req: {retry: {limit: 0}, timeout: {request: 3000}},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
      const crawler = new Downloader(pathToFileURL(config).href);
      const make = (name = 'parent.bin', bytes = 4) => ({...resource.createResource({
        type: mode === 'stream' ? resource.ResourceType.StreamingBinary : resource.ResourceType.Binary,
        depth: 0, url: origin + '/' + name, refUrl: origin + '/', localRoot: output}), body: Buffer.alloc(bytes)});
      try {
        await crawler.init;
        const parent = make('parent.bin', mode === 'concurrent' ? 6 : 4);
        if (['http', 'local', 'stream'].includes(mode)) delete parent.body;
        if (mode === 'local') parent.downloadLink = pathToFileURL(source).href;
        assert.equal(crawler.addProcessedResource(parent), true);
        let concurrent;
        if (mode === 'concurrent') {
          concurrent = make('small.bin');
          delete concurrent.body;
          assert.equal(crawler.addProcessedResource(concurrent), true);
        }
        if (mode === 'queued') {
          assert.equal(crawler.addProcessedResource(make('second.bin', 6)), true);
          const rejected = make('overflow.bin', 1);
          assert.equal(crawler.addProcessedResource(rejected), false);
          assert.equal(rejected.meta.error.code, 'ERR_BUFFER_BUDGET');
          assert.equal(crawler.bufferedBytes, 10);
          await crawler.dispose();
          assert.equal(crawler.bufferedBytes, 0);
          continue;
        }
        await crawler.start();
        if (concurrent) {
          const until = Date.now() + 5000;
          while (crawler.outcomes.get(concurrent.url).status !== 'failed') {
            if (Date.now() > until) throw new Error('Concurrent body did not reject');
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          assert.equal(concurrent.meta.error.code, 'ERR_BUFFER_BUDGET');
          await fs.writeFile(path.join(output, 'release'), 'ready');
        }
        if (mode === 'cancel') {
          const until = Date.now() + 5000;
          while (crawler.outcomes.get(parent.url).status !== 'running') {
            if (Date.now() > until) throw new Error('Task did not start');
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          await crawler.dispose();
          assert.equal(crawler.outcomes.get(parent.url).status, 'cancelled');
        } else {
          await crawler.onIdle();
          const failed = ['child-overflow', 'transform', 'http', 'local', 'generated'].includes(mode);
          assert.equal(crawler.outcomes.get(parent.url).status, failed ? 'failed' : 'saved', mode);
          if (failed) assert.equal(parent.meta.error.code, 'ERR_BUFFER_BUDGET', mode);
          if (mode === 'children') assert.equal(crawler.downloadedCount, 3);
          if (mode === 'child-overflow') assert.equal(crawler.downloadedCount, 1);
          if (['duplicate', 'queue-rejected'].includes(mode)) assert.equal(crawler.downloadedCount, 2);
          if (mode === 'stream') assert.equal(crawler.peakBufferedBytes, 0);
          if (mode === 'concurrent') assert.equal(crawler.downloadedCount, 1);
          if (mode === 'transform') {
            assert.equal(crawler.bufferedBytes, 0);
            const retry = make();
            retry.meta.retry = true;
            assert.equal(crawler.addProcessedResource(retry), true);
            await crawler.onIdle();
            assert.equal(crawler.outcomes.get(retry.url).status, 'saved');
            assert.equal(crawler.outcomes.get(retry.url).attempt, 2);
          }
          if (['children', 'child-overflow', 'duplicate', 'queue-rejected'].includes(mode)) {
            assert.equal(crawler.outcomes.get(origin + '/child-1.bin').status, 'saved');
          }
        }
        assert.equal(crawler.bufferedBytes, 0, mode + ' releases all reservations');
        assert.ok(crawler.peakBufferedBytes <= 10, mode + ' respects the aggregate budget');
      } finally { await crawler.dispose(); }
    }
  }
  const silentWorker = path.join(root, 'silent-worker.mjs');
  await fs.writeFile(silentWorker, `
import {parentPort, workerData} from 'node:worker_threads';
workerData.workerChannels.taskPort.on('message', () => {});
parentPort.postMessage({version: 1, type: 'ready'});
`);
  const config = path.join(root, 'silent-options.mjs');
  await fs.writeFile(config, `
import {lifeCycle, options} from ${JSON.stringify(entry)};
export default options.defaultDownloadOptions({...lifeCycle.defaultLifeCycle(),
  initialUrl: [], localRoot: ${JSON.stringify(root)}, concurrency: 1, workerCount: 1,
  maxBufferedBytes: 10,
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
  const silent = new downloader.MultiThreadDownloader(pathToFileURL(config).href,
    {pathToWorker: silentWorker, workerPool: {taskTimeout: 50}});
  try {
    await silent.init;
    let exited = false;
    silent.pool.workers[0].worker.once('exit', () => { exited = true; });
    const url = origin + '/silent.bin';
    silent.addProcessedResource({...resource.createResource({type: resource.ResourceType.Binary,
      depth: 0, url, refUrl: url, localRoot: root}), body: Buffer.alloc(8)});
    await silent.start();
    await silent.onIdle();
    assert.equal(exited, true, 'body credit is retained until an unresponsive worker exits, even before its first RPC');
    assert.equal(silent.bufferedBytes, 0);
    assert.equal(silent.outcomes.get(url).status, 'failed');
  } finally { await silent.dispose(); }
  console.log(`${process.version}: 24 aggregate-buffer scenarios and pre-RPC worker timeout cleanup pass`);
} finally {
  clearTimeout(deadline);
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fs.rm(root, {recursive: true, force: true});
}
