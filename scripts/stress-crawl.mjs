import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';

if (!global.gc) throw new Error('Run with node --expose-gc');
const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
const {downloader, resource} = await import(entry);
const rounds = Number(process.env.WSE_STRESS_ROUNDS ?? 3);
const count = Number(process.env.WSE_STRESS_RESOURCES ?? 64);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 3);
assert.ok(Number.isSafeInteger(count) && count >= 40);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-crawl-stress-'));
const deadline = setTimeout(() => { throw new Error('Crawl stress timed out'); }, 40000);
deadline.unref();
const samples = [];

async function cycle(round, Downloader) {
  const started = performance.now();
  const output = path.join(root, String(round), Downloader.name);
  await fs.mkdir(output, {recursive: true});
  const config = path.join(output, 'options.mjs');
  await fs.writeFile(config, `
import {lifeCycle, options} from ${JSON.stringify(entry)};
const lc = lifeCycle.defaultLifeCycle();
lc.download.unshift(res => {
  res.body = Buffer.alloc(64, res.meta.payload.id % 256);
  return res;
});
lc.processAfterDownload.unshift(async res => {
  const {id, nested} = res.meta.payload;
  if (res.uri.toString() !== res.url || nested[0].round !== ${round}) throw new Error('Resource metadata corruption');
  await new Promise(resolve => setImmediate(resolve));
  return {...res, body: Buffer.alloc(80, id % 256)};
});
export default options.defaultDownloadOptions({...lc, initialUrl: [],
  localRoot: ${JSON.stringify(output)}, concurrency: 8, workerCount: 2,
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
  const crawler = new Downloader(pathToFileURL(config).href);
  const errors = [];
  crawler.handleError = (...args) => errors.push(args);
  try {
    await crawler.init;
    crawler.stop();
    const make = id => {
      const url = 'https://example.test/' + id + '.bin';
      const res = resource.createResource({type: resource.ResourceType.Binary,
        depth: 0, url, refUrl: url, localRoot: output});
      res.meta = {payload: {id, nested: [{round}]}};
      return res;
    };
    for (let id = 0; id < count; id++) {
      assert.notEqual(crawler.addProcessedResource(make(id)), false);
      assert.equal(crawler.addProcessedResource(make(id)), false, 'duplicate admission is skipped');
    }
    crawler.start();
    await crawler.onIdle();
    assert.deepEqual(errors, []);
    assert.equal(crawler.downloadedCount, count);
    const files = await fs.readdir(path.join(output, 'example.test'));
    assert.equal(files.length, count);
    assert.ok(files.every(file => file.endsWith('.bin')));
    for (let id = 0; id < count; id++) {
      assert.deepEqual(await fs.readFile(path.join(output, 'example.test', id + '.bin')),
        Buffer.alloc(80, id % 256));
    }
    const workers = crawler instanceof downloader.MultiThreadDownloader ?
      crawler.pool.workers.map(info => info.worker) : [];
    crawler.stop();
    for (let id = count; id < count + 20; id++) crawler.addProcessedResource(make(id));
    await crawler.dispose();
    assert.equal(crawler.queueSize, 0);
    assert.equal(crawler.queuePending, 0);
    assert.equal(crawler.addProcessedResource(make(count + 20)), false);
    assert.ok(workers.every(worker => worker.threadId === -1));
    assert.equal((await fs.readdir(path.join(output, 'example.test'))).length, count);
    return {mode: Downloader.name, milliseconds: performance.now() - started,
      savedResources: count, duplicateResources: count, clearedQueuedResources: 20};
  } finally {
    await crawler.dispose();
    await fs.rm(output, {recursive: true, force: true});
  }
}

try {
  for (let round = 0; round < rounds; round++) {
    const modes = [];
    for (const Downloader of [downloader.SingleThreadDownloader, downloader.MultiThreadDownloader]) {
      modes.push(await cycle(round, Downloader));
    }
    global.gc();
    samples.push({round, modes, memory: process.memoryUsage()});
  }
  const retainedHeapGrowth = samples.at(-1).memory.heapUsed - samples[1].memory.heapUsed;
  // Covers ESM configuration modules and GC noise; this bounded probe does not
  // qualify sustained process memory or application-owned parser heaps.
  assert.ok(retainedHeapGrowth < 12 * 1024 * 1024, 'Crawl cycles retain growing parent heap');
  console.log(JSON.stringify({node: process.version, rounds, resourcesPerMode: count,
    retainedHeapGrowth, heapGrowthAllowance: 12 * 1024 * 1024, samples}, null, 2));
} finally {
  clearTimeout(deadline);
  await fs.rm(root, {recursive: true, force: true});
}
