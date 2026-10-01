import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
const {downloader, resource} = await import(entry);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-parent-publication-'));
const deadline = setTimeout(() => { throw new Error('Parent publication checks timed out'); }, 30000);
deadline.unref();
try {
  for (const mode of ['timeout', 'crash', 'cancel', 'allocation-cancel', 'published-crash']) {
    const output = path.join(root, mode);
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, 'asset.bin'), 'cached');
    const marker = path.join(output, 'staged');
    const config = path.join(output, 'options.mjs');
    await fs.writeFile(config, `
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {lifeCycle, options, io} from ${JSON.stringify(entry)};
import {publishFile} from ${JSON.stringify(new URL('./output-store.js', entry).href)};
const lc = lifeCycle.defaultLifeCycle();
lc.saveToDisk = [async (res, opt, pipeline) => {
  if (${JSON.stringify(mode)} === 'published-crash') {
    await io.writeFile(path.join(res.localRoot, 'confirmed.bin'), 'confirmed', 'utf8',
      undefined, undefined, res.localRoot);
  }
  await publishFile(path.join(res.localRoot, 'asset.bin'), async staging => {
    await fs.writeFile(staging, 'partial');
    await fs.writeFile(${JSON.stringify(marker)}, 'ready');
    if (${JSON.stringify(mode)}.includes('crash')) process.exit(23);
    await new Promise(() => {});
  }, pipeline.signal, res.localRoot);
}];
export default options.defaultDownloadOptions({...lc, localRoot: ${JSON.stringify(output)},
  initialUrl: [], concurrency: 1, workerCount: 1, maxBufferedBytes: 64,
  workerPool: {taskTimeout: ${mode === 'timeout' ? 1500 : 'undefined'}, shutdownTimeout: 50},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
    const crawler = new downloader.MultiThreadDownloader(pathToFileURL(config).href);
    const originalMkdtemp = fs.mkdtemp;
    let allocationStarted;
    const allocating = new Promise(resolve => { allocationStarted = resolve; });
    let releaseAllocation;
    const released = new Promise(resolve => { releaseAllocation = resolve; });
    if (mode === 'allocation-cancel') fs.mkdtemp = async (...args) => {
      if (String(args[0]).includes('.wse-stage-')) {
        allocationStarted();
        await released;
      }
      return originalMkdtemp(...args);
    };
    try {
      await crawler.init;
      const url = 'https://example.test/' + mode;
      const res = resource.createResource({type: resource.ResourceType.Binary, depth: 0,
        url, refUrl: url, localRoot: output, savePath: 'asset.bin'});
      res.body = Buffer.from('body');
      assert.equal(crawler.addProcessedResource(res), true);
      await crawler.start();
      if (mode === 'allocation-cancel') {
        await allocating;
        const exited = new Promise(resolve => crawler.pool.workers[0].worker.once('exit', resolve));
        const closing = crawler.dispose();
        await exited;
        releaseAllocation();
        await closing;
      }
      const readyDeadline = Date.now() + 5000;
      while (mode !== 'allocation-cancel' && !await fs.stat(marker).then(() => true, () => false)) {
        if (Date.now() > readyDeadline) throw new Error('Staging writer did not start: ' + mode);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (mode === 'cancel') await crawler.dispose();
      await crawler.onIdle();
      assert.equal(crawler.bufferedBytes, 0, 'worker failure/cancellation releases byte reservations');
      assert.ok(crawler.peakBufferedBytes <= 64);
      assert.equal(await fs.readFile(path.join(output, 'asset.bin'), 'utf8'), 'cached');
      assert.deepEqual((await fs.readdir(output)).filter(name => name.startsWith('.wse-stage-')), []);
      assert.equal(crawler.downloadedCount, 0);
      assert.deepEqual(crawler.outcomes.get(url), {status: mode.endsWith('cancel') ? 'cancelled' : 'failed',
        attempt: 1, url, downloaded: true, publishedFiles: mode === 'published-crash' ? 1 : 0});
      if (mode === 'published-crash') {
        assert.equal(await fs.readFile(path.join(output, 'confirmed.bin'), 'utf8'), 'confirmed');
      }
    } finally {
      fs.mkdtemp = originalMkdtemp;
      releaseAllocation();
      await crawler.dispose();
    }
  }
  console.log(`${process.version}: parent cleans worker staging after timeout, crash, and forced cancellation`);
} finally {
  clearTimeout(deadline);
  await fs.rm(root, {recursive: true, force: true});
}
