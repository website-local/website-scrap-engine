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
const rounds = Number(process.env.WSE_STRESS_ROUNDS ?? 6);
const count = Number(process.env.WSE_STRESS_RESOURCES ?? 200);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 3);
assert.ok(Number.isSafeInteger(count) && count >= 40);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-crawl-stress-'));
const deadline = setTimeout(() => { throw new Error('Crawl stress timed out'); }, 180000);
deadline.unref();
const samples = [];

async function cycle(round) {
  const started = performance.now();
  const crawlers = [];
  const records = [];
  try {
    for (const Downloader of [downloader.SingleThreadDownloader, downloader.MultiThreadDownloader]) {
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
  if (res.uri.toString() !== res.url || nested[0].round !== ${round}) throw new Error('Wire/context corruption');
  if (id % 37 === 0 && !res.meta.retry) throw new Error('intentional stress failure');
  await new Promise(resolve => setImmediate(resolve));
  return {...res, body: Buffer.alloc(80, id % 256)};
});
export default options.defaultDownloadOptions({...lc, initialUrl: [],
  localRoot: ${JSON.stringify(output)}, concurrency: 8, workerCount: 2,
  maxResourceBytes: 128, maxBufferedBytes: 4096, maxQueuedResources: ${count + 20},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
      const crawler = new Downloader(pathToFileURL(config).href);
      crawlers.push(crawler);
      await crawler.init;
      const make = (id, retry = false) => {
        const url = 'https://example.test/' + id + '.bin';
        const res = resource.createResource({type: resource.ResourceType.Binary,
          depth: 0, url, refUrl: url, localRoot: output});
        res.meta = {payload: {id, nested: [{round}]}, retry};
        return res;
      };
      for (let id = 0; id < count; id++) assert.equal(crawler.addProcessedResource(make(id)), true);
      records.push({crawler, output, make, workers: crawler.pool?.workers.map(info => info.worker) ?? []});
    }
    await Promise.all(crawlers.map(crawler => crawler.start()));
    await Promise.all(crawlers.map(crawler => crawler.onIdle()));
    const failures = Math.ceil(count / 37);
    for (const {crawler, make} of records) {
      assert.equal(crawler.downloadedCount, count - failures);
      assert.equal(crawler.bufferedBytes, 0);
      for (let id = 0; id < count; id += 37) assert.equal(crawler.addProcessedResource(make(id, true)), true);
    }
    await Promise.all(crawlers.map(crawler => crawler.onIdle()));
    for (const {crawler, output, make} of records) {
      assert.equal(crawler.downloadedCount, count);
      assert.equal(crawler.outcomes.size, count);
      assert.ok([...crawler.outcomes.values()].every(outcome => outcome.status === 'saved'));
      for (let id = 0; id < count; id += 37) {
        assert.equal(crawler.outcomes.get('https://example.test/' + id + '.bin').attempt, 2);
      }
      assert.ok(crawler.peakBufferedBytes > 0 && crawler.peakBufferedBytes <= 4096);
      const files = await fs.readdir(path.join(output, 'example.test'));
      assert.equal(files.length, count);
      assert.ok(files.every(file => file.endsWith('.bin')));
      for (const id of [0, 37, count - 1]) {
        assert.deepEqual(await fs.readFile(path.join(output, 'example.test', id + '.bin')), Buffer.alloc(80, id % 256));
      }
      crawler.stop();
      for (let id = count; id < count + 20; id++) assert.equal(crawler.addProcessedResource(make(id)), true);
    }
    await Promise.all(crawlers.map(crawler => crawler.dispose()));
    for (const {crawler, workers} of records) {
      assert.equal(crawler.bufferedBytes, 0);
      assert.equal([...crawler.outcomes.values()].filter(outcome => outcome.status === 'cancelled').length, 20);
      assert.ok(workers.every(worker => worker.threadId === -1));
    }
    return {round, milliseconds: performance.now() - started,
      successfulResources: count * 2, retriedResources: failures * 2, cancelledResources: 40,
      peakReservedBytes: records.map(({crawler}) => crawler.peakBufferedBytes)};
  } finally {
    await Promise.all(crawlers.map(crawler => crawler.dispose()));
    await fs.rm(path.join(root, String(round)), {recursive: true, force: true});
  }
}

try {
  for (let round = 0; round < rounds; round++) {
    const result = await cycle(round);
    global.gc();
    samples.push({...result, memory: process.memoryUsage()});
    process.stderr.write(`stress round ${round}: ${result.successfulResources} saved, ` +
      `${result.retriedResources} retried, ${result.cancelledResources} cancelled\n`);
  }
  const retainedHeapGrowth = samples.at(-1).memory.heapUsed - samples[1].memory.heapUsed;
  // Broad allowance for ESM configuration modules and runtime/GC noise. This is
  // a bounded regression probe, not a proof against all long-running leaks.
  assert.ok(retainedHeapGrowth < 12 * 1024 * 1024, 'Crawl cycles retain growing parent heap');
  console.log(JSON.stringify({node: process.version, rounds, resourcesPerMode: count,
    retainedHeapGrowth, heapGrowthAllowance: 12 * 1024 * 1024, samples}, null, 2));
} finally {
  clearTimeout(deadline);
  await fs.rm(root, {recursive: true, force: true});
}
