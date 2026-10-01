import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
const {downloader, resource} = await import(entry);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-adjustment-'));
let received = 0;
let released = false;
const held = [];
const server = createServer((_request, response) => {
  response.setHeader('Connection', 'close');
  ++received;
  if (received <= 8 || released) response.end('body');
  else held.push(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const deadline = setTimeout(() => { throw new Error('Adjustment checks timed out'); }, 30000);
deadline.unref();
try {
  for (const Downloader of [downloader.SingleThreadDownloader, downloader.MultiThreadDownloader]) {
    received = 0;
    released = false;
    held.length = 0;
    const output = path.join(root, Downloader.name);
    await fs.mkdir(output);
    const config = path.join(output, 'options.mjs');
    await fs.writeFile(config, `
import {lifeCycle, options} from ${JSON.stringify(entry)};
export default options.defaultDownloadOptions({...lifeCycle.defaultLifeCycle(),
  localRoot: ${JSON.stringify(output)}, initialUrl: [], concurrency: 8, workerCount: 2,
  minConcurrency: 2, maxConcurrency: 16, adjustConcurrencyPeriod: 100,
  req: {retry: {limit: 0}, timeout: {request: 5000}},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
    const crawler = new Downloader(pathToFileURL(config).href);
    try {
      await crawler.init;
      for (let index = 0; index < 48; index++) {
        const url = origin + '/' + index + '.bin';
        assert.equal(crawler.addProcessedResource(resource.createResource({type: resource.ResourceType.Binary,
          depth: 0, url, refUrl: url, localRoot: output})), true);
      }
      await crawler.start();
      const waitingDeadline = Date.now() + 5000;
      while (held.length < 2 || crawler.downloadedCount < 8) {
        if (Date.now() > waitingDeadline) throw new Error('Initial resources did not finish');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      // Isolate a zero-completion interval. Under host load the initial eight
      // completions can span several samples and legitimately trigger growth.
      crawler.stop();
      const waitingAtStart = held.length;
      const ceilingAtStall = Math.max(held.length, crawler.queuePending, crawler.concurrency);
      await crawler.start();
      const backoffDeadline = Date.now() + 5000;
      while (crawler.concurrency > 2) {
        if (Date.now() > backoffDeadline) throw new Error('Stalled origin did not trigger backoff');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(held.length <= ceilingAtStall, 'an isolated stall must not increase in-flight load');
      assert.equal(crawler.concurrency, 2, 'stalls must reduce future admissions to the minimum');
      assert.ok(crawler.queueSize > 0);
      assert.ok(waitingAtStart <= held.length);
      released = true;
      held.forEach(response => response.end('body'));
      await crawler.onIdle();
      assert.equal(crawler.downloadedCount, 48);
      assert.equal(received, 48);
      assert.ok([...crawler.outcomes.values()].every(item => item.status === 'saved'));
    } finally { await crawler.dispose(); }
  }
  console.log(`${process.version}: stalled HTTP origins do not trigger concurrency growth in either mode`);
} finally {
  clearTimeout(deadline);
  held.forEach(response => response.destroy());
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fs.rm(root, {recursive: true, force: true});
}
