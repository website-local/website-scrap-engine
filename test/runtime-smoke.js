import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const entryUrl = process.argv[2] ?
  pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
const {downloader, io} = await import(entryUrl);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-runtime-'));
const bytes = Buffer.from([0xff, 0x00, 0x80, 0x42]);
const requests = [];
const server = createServer((request, response) => {
  requests.push({url: request.url, header: request.headers['x-runtime']});
  response.setHeader('Connection', 'close');
  if (request.url === '/image.bin') {
    response.setHeader('Content-Type', 'application/octet-stream');
    response.end(bytes);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<html><body><img src="/image.bin"></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/index.html`;
const deadline = setTimeout(() => {
  throw new Error('Runtime smoke test timed out');
}, 30000);
deadline.unref();

try {
  await io.mkdirRetry(path.join(root, 'custom-workers'));
  const workerPath = path.join(root, 'custom-workers', 'channels.mjs');
  await fs.writeFile(workerPath, `
import {parentPort, workerData} from 'node:worker_threads';
const {taskPort, logPort} = workerData.workerChannels;
taskPort.on('message', ({taskId, body}) => {
  taskPort.postMessage({taskId, type: 1, body: body + 1});
});
parentPort.on('message', ({type}) => {
  if (type === 'close') {
    taskPort.close();
    logPort.close();
    parentPort.postMessage({type: 'closed'});
  }
});
parentPort.postMessage({type: 'ready'});
`);
  const pool = new downloader.WorkerPool(1, workerPath, {});
  try {
    await pool.ready;
    assert.equal(pool.workingTasks instanceof Map, true);
    assert.equal((await pool.submitTask(41)).body, 42);
    assert.equal(pool.workingTasks.size, 0);
  } finally {
    await pool.dispose();
  }

  for (const [mode, Downloader] of [
    ['main', downloader.SingleThreadDownloader],
    ['worker', downloader.MultiThreadDownloader]
  ]) {
    requests.length = 0;
    const caseRoot = path.join(root, mode);
    await fs.mkdir(caseRoot);
    const optionsPath = path.join(caseRoot, 'options.mjs');
    const outputRoot = path.join(caseRoot, 'output');
    await fs.writeFile(optionsPath, `
import {isMainThread} from 'node:worker_threads';
import path from 'node:path';
import {lifeCycle, options, resource} from ${JSON.stringify(entryUrl)};
const lc = lifeCycle.defaultLifeCycle();
lc.generateSavePath.push(savePath => path.join('hooks', savePath));
lc.processAfterDownload.push(res => {
  if (res.type === resource.ResourceType.Html) {
    res.meta.doc('body').attr('data-executor', isMainThread ? 'main' : 'worker');
  }
  return res;
});
export default options.defaultDownloadOptions({
  ...lc,
  localRoot: ${JSON.stringify(outputRoot)},
  initialUrl: [${JSON.stringify(url)}],
  concurrency: 1,
  workerCount: 1,
  req: {retry: {limit: 0}, timeout: {request: 2000}},
  createLogger: () => ({
    trace() {}, debug() {}, info() {}, warn() {}, error() {},
    isTraceEnabled: () => false
  })
});
`);
    const overrides = {req: {headers: {'x-runtime': 'compatibility'}}};
    const before = structuredClone(overrides);
    const crawler = new Downloader(pathToFileURL(optionsPath).href, overrides);
    const errors = [];
    crawler.handleError = (...args) => errors.push(args);
    try {
      await crawler.init;
      crawler.start();
      await crawler.onIdle();
      assert.deepEqual(errors, []);
      assert.equal(crawler.downloadedCount, 2);
      assert.equal(requests.length, 2);
      assert.ok(requests.every(request => request.header === 'compatibility'));
      const savedRoot = path.join(outputRoot, 'hooks', '127.0.0.1');
      const html = await fs.readFile(path.join(savedRoot, 'index.html'), 'utf8');
      assert.ok(html.includes(`data-executor="${mode}"`));
      assert.deepEqual(await fs.readFile(path.join(savedRoot, 'image.bin')), bytes);
      assert.deepEqual(overrides, before);
      console.log(`${process.version}: ${mode} downloader and save-path hooks passed`);
    } finally {
      await crawler.dispose();
    }
  }
} finally {
  clearTimeout(deadline);
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  await fs.rm(root, {recursive: true, force: true});
}
