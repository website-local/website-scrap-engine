import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';

const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
const {downloader, resource} = await import(entry);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-lifecycle-'));
const body = '<html><body>complete</body></html>';
const deadline = setTimeout(() => { throw new Error('Lifecycle checks timed out'); }, 30000);
deadline.unref();
const crawlers = [];
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const optionsPath = path.join(root, 'options.mjs');
await fs.writeFile(optionsPath, `
import {lifeCycle, options, downloader} from ${JSON.stringify(entry)};
import {isMainThread} from 'node:worker_threads';
import {writeFile} from 'node:fs/promises';
export const events = [];
let signalHookStarted;
export const hookStarted = new Promise(resolve => { signalHookStarted = resolve; });
let signalWorkerHookStarted;
export const workerHookStarted = new Promise(resolve => { signalWorkerHookStarted = resolve; });
const lc = lifeCycle.defaultLifeCycle();
lc.processAfterDownload.push(async (res, _submit, options, pipeline) => {
  if (options.meta.waitForCancel) {
    await new Promise(resolve => {
      pipeline.signal.addEventListener('abort', resolve, {once: true});
      signalHookStarted();
      if (!isMainThread) downloader.getWorkerChannels().logPort.postMessage({
        version: 1, type: 0, taskId: -1,
        body: {level: 'info', logType: 'custom.workerWaiting', content: []}
      });
    });
    if (options.meta.cancelMarker) await writeFile(options.meta.cancelMarker, 'cleaned');
  }
  return res;
});
export default options.defaultDownloadOptions({
  ...lc, localRoot: ${JSON.stringify(root)},
  initialUrl: [], concurrency: 1, workerCount: 1,
  req: {retry: {limit: 0}, timeout: {request: 5000}},
  createLogger: ({meta}) => ({
    trace: (type, ...args) => events.push({label: meta.label, type, args}),
    debug() {}, info: (type, ...args) => {
      events.push({label: meta.label, type, args});
      if (type === 'custom.workerWaiting') signalWorkerHookStarted();
    },
    warn() {}, error() {}, isTraceEnabled: () => true
  })
});
`);
const optionsUrl = pathToFileURL(optionsPath).href;
try {
  for (const Downloader of [downloader.SingleThreadDownloader, downloader.MultiThreadDownloader]) {
    for (const drain of [false, true]) {
      const out = path.join(root, `${Downloader.name}-${drain}`);
      let received;
      const started = new Promise(resolve => { received = resolve; });
      let respond;
      let count = 0;
      server.removeAllListeners('request');
      server.on('request', (request, response) => {
        count++;
        response.setHeader('Connection', 'close');
        respond = () => response.end(body);
        received();
      });
      const crawler = new Downloader(optionsUrl, {
        localRoot: out, initialUrl: drain ? [`${origin}/index.html`] :
          [`${origin}/index.html`, `${origin}/queued.html`]
      });
      crawlers.push(crawler);
      await crawler.init;
      await nextTurn();
      assert.equal(count, 0, 'initialization must not start downloads');
      assert.equal(crawler.state, 'ready');
      const pendingStart = crawler.start();
      crawler.stop();
      await pendingStart;
      assert.equal(count, 0);
      await crawler.start();
      await started;
      const closing = crawler.dispose({drain});
      assert.equal(crawler.dispose(), closing, 'disposal must be idempotent');
      assert.equal(crawler.addProcessedResource(resource.createResource({
        type: resource.ResourceType.Html, depth: 0, url: `${origin}/late.html`,
        refUrl: origin, localRoot: out
      })), false);
      if (drain) respond();
      await closing;
      assert.equal(crawler.state, 'closed');
      assert.equal(crawler.queuePending, 0);
      assert.equal(crawler.queueSize, 0);
      await assert.rejects(crawler.start(), /closing or closed/);
      const target = path.join(out, '127.0.0.1', 'index.html');
      if (drain) assert.ok((await fs.readFile(target, 'utf8')).includes('<body>complete</body>'));
      else await assert.rejects(fs.stat(target), {code: 'ENOENT'});
      assert.equal(count, 1);
    }
  }

  server.removeAllListeners('request');
  server.on('request', (_request, response) => {
    response.setHeader('Connection', 'close');
    response.end(body);
  });
  const {events, hookStarted, workerHookStarted} = await import(optionsUrl);
  const cooperative = new downloader.SingleThreadDownloader(optionsUrl, {
    meta: {waitForCancel: true}, localRoot: path.join(root, 'cooperative'),
    initialUrl: [`${origin}/index.html`]
  });
  crawlers.push(cooperative);
  await cooperative.start();
  await hookStarted;
  await cooperative.dispose();
  await assert.rejects(fs.stat(path.join(root, 'cooperative', '127.0.0.1', 'index.html')),
    {code: 'ENOENT'});
  const cancelMarker = path.join(root, 'worker-cleaned');
  const workerCooperative = new downloader.MultiThreadDownloader(optionsUrl, {
    meta: {waitForCancel: true, cancelMarker}, localRoot: path.join(root, 'worker-cooperative'),
    initialUrl: [origin + '/index.html'], workerPool: {shutdownTimeout: 5000}
  });
  crawlers.push(workerCooperative);
  await workerCooperative.start();
  await workerHookStarted;
  await workerCooperative.dispose();
  assert.equal(await fs.readFile(cancelMarker, 'utf8'), 'cleaned');
  assert.equal(workerCooperative.pool.workers[0].worker.threadId, -1);
  await assert.rejects(fs.stat(path.join(root, 'worker-cooperative', '127.0.0.1', 'index.html')),
    {code: 'ENOENT'});
  const pair = ['alpha', 'beta'].map(label => new downloader.SingleThreadDownloader(optionsUrl, {
    meta: {label}, localRoot: path.join(root, label), initialUrl: [`${origin}/${label}.html`]
  }));
  crawlers.push(...pair);
  await Promise.all(pair.map(crawler => crawler.init));
  await Promise.all(pair.map(crawler => crawler.start()));
  await Promise.all(pair.map(crawler => crawler.onIdle()));
  for (const label of ['alpha', 'beta']) {
    const requests = events.filter(event => event.label === label && event.type === 'io.http.request');
    assert.equal(requests.length, 1);
    assert.ok(requests[0].args[0].includes(`/${label}.html`));
  }

  const failedPath = path.join(root, 'invalid.mjs');
  await fs.writeFile(failedPath, 'throw new Error("configuration failed");');
  for (const Downloader of [downloader.SingleThreadDownloader, downloader.MultiThreadDownloader]) {
    const failed = new Downloader(pathToFileURL(failedPath).href);
    crawlers.push(failed);
    await assert.rejects(failed.init, /configuration failed/);
    await failed.dispose();
    assert.equal(failed.state, 'closed');
  }
  const workerFailedPath = path.join(root, 'worker-init-failed.mjs');
  await fs.writeFile(workerFailedPath, `
import {isMainThread} from 'node:worker_threads';
import {lifeCycle, options} from ${JSON.stringify(entry)};
export default options.defaultDownloadOptions({
  ...lifeCycle.defaultLifeCycle(),
  initialUrl: [], concurrency: 1, workerCount: 1,
  localRoot: ${JSON.stringify(root)},
  init: [async () => {
    if (!isMainThread) throw new Error('worker pipeline initialization failed');
  }]
});
`);
  const workerFailed = new downloader.MultiThreadDownloader(pathToFileURL(workerFailedPath).href);
  crawlers.push(workerFailed);
  await assert.rejects(workerFailed.init, /worker pipeline initialization failed/);
  assert.equal(workerFailed.pool.workers[0].worker.threadId, -1);
  await workerFailed.dispose();
  const workerWaitingPath = path.join(root, 'worker-init-waiting.mjs');
  await fs.writeFile(workerWaitingPath, `
import {isMainThread} from 'node:worker_threads';
import base from ${JSON.stringify(optionsUrl)};
export default {...base, init: [async () => {
  if (!isMainThread) await new Promise(() => {});
}]};
`);
  let workerOnline;
  const online = new Promise(resolve => { workerOnline = resolve; });
  const workerWaiting = new downloader.MultiThreadDownloader(
    pathToFileURL(workerWaitingPath).href, undefined, (filename, options) => {
      const worker = new Worker(filename, options);
      worker.once('online', workerOnline);
      return worker;
    });
  crawlers.push(workerWaiting);
  await online;
  const waitingRejected = assert.rejects(workerWaiting.init, /disposed/);
  await workerWaiting.dispose();
  await waitingRejected;
  assert.equal(workerWaiting.pool.workers[0].worker.threadId, -1);
  console.log(`${process.version}: explicit startup, cancel/drain cleanup, and crawl isolation passed`);
} finally {
  await Promise.all(crawlers.map(crawler => crawler.dispose()));
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
  clearTimeout(deadline);
  await fs.rm(root, {recursive: true, force: true});
}
