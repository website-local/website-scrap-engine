import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
const {downloader, resource} = await import(entry);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-failure-retry-'));
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/file.bin`;
const deadline = setTimeout(() => { throw new Error('Failure/retry checks timed out'); }, 30000);
deadline.unref();
try {
  for (const Downloader of [downloader.SingleThreadDownloader, downloader.MultiThreadDownloader]) {
    for (const stage of ['download', 'process', 'save', 'process-undefined', 'process-size']) {
      let requests = 0;
      server.removeAllListeners('request');
      server.on('request', (_request, response) => {
        response.setHeader('Connection', 'close');
        response.statusCode = stage === 'download' && ++requests === 1 ? 500 : 200;
        response.end('complete');
      });
      const output = path.join(root, Downloader.name, stage);
      await fs.mkdir(output, {recursive: true});
      const config = path.join(output, 'options.mjs');
      await fs.writeFile(config, `
import {lifeCycle, options} from ${JSON.stringify(entry)};
const lc = lifeCycle.defaultLifeCycle();
let attempts = 0;
const failOnce = res => {
  if (++attempts === 1) {
    if (${JSON.stringify(stage)} === 'process-size') return {...res, body: Buffer.alloc(9)};
    if (${JSON.stringify(stage)} === 'process-undefined') throw undefined;
    throw new Error('first attempt failed');
  }
  return res;
};
if (${JSON.stringify(stage)}.startsWith('process')) lc.processAfterDownload.unshift(failOnce);
if (${JSON.stringify(stage)} === 'save') lc.saveToDisk.unshift(failOnce);
export default options.defaultDownloadOptions({...lc,
  localRoot: ${JSON.stringify(output)}, initialUrl: [], concurrency: 1, workerCount: 1,
  maxResourceBytes: ${JSON.stringify(stage)} === 'process-size' ? 8 : undefined,
  req: {retry: {limit: 0}, timeout: {request: 2000}},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {},
    isTraceEnabled: () => false})
});
`);
      const crawler = new Downloader(pathToFileURL(config).href);
      const make = () => resource.createResource({type: resource.ResourceType.Binary,
        depth: 0, url, refUrl: url, localRoot: output, encoding: null});
      try {
        await crawler.init;
        const first = make();
        assert.equal(crawler.addProcessedResource(first), true);
        assert.equal(crawler.addProcessedResource(make()), false, 'active duplicate');
        await crawler.start();
        await crawler.onIdle();
        assert.equal(crawler.downloadedCount, 0, `${Downloader.name}/${stage} failed count`);
        assert.ok(first.meta.errorCause);
        assert.equal(crawler.outcomes.get(url).status, 'failed');
        assert.equal(crawler.outcomes.get(url).attempt, 1);
        if (stage === 'process-size') assert.equal(first.meta.error.code, 'ERR_RESOURCE_SIZE_LIMIT');
        assert.equal(crawler.queuedUrl.has(url), false, 'failed reservation released');
        await assert.rejects(fs.stat(path.join(output, '127.0.0.1', 'file.bin')), {code: 'ENOENT'});
        assert.equal(crawler.addProcessedResource(make()), true, 'explicit retry admitted');
        await crawler.onIdle();
        assert.equal(crawler.downloadedCount, 1);
        assert.equal(crawler.outcomes.get(url).status, 'saved');
        assert.equal(crawler.outcomes.get(url).attempt, 2);
        assert.equal(crawler.outcomes.get(url).publishedFiles, 1);
        assert.equal(crawler.addProcessedResource(make()), false, 'success remains deduplicated');
        assert.equal(await fs.readFile(path.join(output, '127.0.0.1', 'file.bin'), 'utf8'), 'complete');
      } finally { await crawler.dispose(); }
    }
  }
  console.log(`${process.version}: failed work is not counted and explicit retries succeed in both modes`);
} finally {
  clearTimeout(deadline);
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fs.rm(root, {recursive: true, force: true});
}
