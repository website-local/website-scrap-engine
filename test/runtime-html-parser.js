import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
const parser = process.argv[3] ? pathToFileURL(path.resolve(process.argv[3])).href :
  new URL('./grovedom-fixture.js', import.meta.url).href;
const {downloader, resource} = await import(entry);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-html-parser-'));
const trace = path.join(root, 'trace.jsonl');
const wrapper = path.join(root, 'parser.mjs');
const poolMaxBytes = 2 * 1024 * 1024;
await fs.writeFile(wrapper, `
import * as parser from ${JSON.stringify(parser)};
import {appendFileSync} from 'node:fs';
import {threadId} from 'node:worker_threads';
let sequence = 0;
const record = value => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({threadId, ...value}) + '\\n');
export function init(options) { parser.init(options); record({event: 'init', options}); }
export function load(...args) {
  const doc = parser.load(...args), id = ++sequence;
  record({event: 'load', id});
  const dispose = doc.dispose.bind(doc);
  doc.dispose = () => { try { return dispose(); } finally { record({event: 'dispose', id}); } };
  return doc;
}
`);

try {
  for (const [mode, Downloader] of [
    ['single', downloader.SingleThreadDownloader], ['worker', downloader.MultiThreadDownloader]
  ]) {
    for (const phase of [
      'success', 'download-failure', 'process-failure', 'discard', 'save-failure', 'retry', 'cancel', 'binary'
    ]) {
      const caseRoot = path.join(root, mode + '-' + phase);
      const ready = path.join(caseRoot, 'ready');
      const optionsPath = path.join(caseRoot, 'options.mjs');
      const output = path.join(caseRoot, 'output');
      await fs.mkdir(caseRoot);
      const module = phase === 'binary' ? pathToFileURL(path.join(root, 'missing-parser.mjs')).href :
        pathToFileURL(wrapper).href;
      await fs.writeFile(optionsPath, `
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {lifeCycle, options, resource, loadHtml} from ${JSON.stringify(entry)};
const phase = ${JSON.stringify(phase)};
const lc = lifeCycle.defaultLifeCycle();
let failedDocument;
export const statusEvents = [];
lc.download.unshift((res, _request, options) => {
  res.type = phase === 'binary' ? resource.ResourceType.Binary : resource.ResourceType.Html;
  res.body = res.url.endsWith('/child.html') ? '<p>child resource</p>' :
    '<html><body><a href="/child.html">child</a><iframe srcdoc="&lt;p&gt;nested&lt;/p&gt;"></iframe></body></html>';
  // Download hooks run in the parent for multi-thread crawls. They must also
  // select the configured parser, including the synchronous first-load path.
  if (phase !== 'binary') {
    res.meta.doc = loadHtml(res.body, undefined, undefined, options);
    assert.ok(res.meta.doc.html());
  }
  if (phase === 'download-failure') throw new Error('injected download failure');
  return res;
});
lc.processAfterDownload.push(async (res, _submit, options, pipeline) => {
  if (res.type !== resource.ResourceType.Html) return res;
  assert.ok(res.meta.doc.html());
  const generated = loadHtml('<em>generated</em>', undefined, undefined, options);
  try { assert.ok(generated.html()); }
  finally { generated.dispose(); }
  res.meta.doc('body').attr('data-owned', 'yes');
  if (phase === 'retry' && res.url.endsWith('/index.html')) {
    if (!failedDocument) {
      failedDocument = res.meta.doc;
      throw new Error('injected first-attempt failure');
    }
    assert.notEqual(res.meta.doc, failedDocument);
    assert.throws(() => failedDocument.html());
  }
  if (phase === 'process-failure') throw new Error('injected process failure');
  if (phase === 'discard') return;
  if (phase === 'cancel') {
    await writeFile(${JSON.stringify(ready)}, 'ready');
    await new Promise(resolve => {
      if (pipeline.signal.aborted) resolve();
      else pipeline.signal.addEventListener('abort', resolve, {once: true});
    });
  }
  return res;
});
lc.saveToDisk.unshift(res => {
  if (res.meta.doc) assert.ok(res.meta.doc.html());
  if (phase === 'save-failure') throw new Error('injected save failure');
  return res;
});
lc.statusChange = [
  async (res, status, options) => {
    if (status !== 'error') return;
    // A failed pipeline has already discarded its document. Status reporting
    // can create a new one that remains owned until every listener finishes.
    const doc = res.meta.doc ||= loadHtml('<p>error status</p>', undefined, undefined, options);
    statusEvents.push({event: 'start', url: res.url});
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(doc.html());
    const generated = loadHtml('<p>error report</p>', undefined, undefined, options);
    assert.equal(typeof generated.dispose, 'function');
    try { assert.ok(generated.html()); }
    finally { generated.dispose(); }
    statusEvents.push({event: 'resumed', url: res.url});
    throw new Error('the following status listener must still run');
  },
  async (res, status) => {
    if (status !== 'error') return;
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(res.meta.doc.html());
    statusEvents.push({event: 'following', url: res.url});
  }
];
export default options.defaultDownloadOptions({
  ...lc, localRoot: ${JSON.stringify(output)},
  initialUrl: phase === 'retry' ? [] : ['https://example.test/index.html'],
  concurrency: 2, workerCount: 1, maxDepth: 1, htmlParser: 'grovedom',
  grovedom: {module: ${JSON.stringify(module)}, poolSize: 4, poolMaxBytes: ${poolMaxBytes}},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
      const {statusEvents} = await import(pathToFileURL(optionsPath).href);
      const crawler = new Downloader(pathToFileURL(optionsPath).href, {grovedom: {poolSize: 2}});
      const errors = [];
      const handleError = crawler.handleError.bind(crawler);
      crawler.handleError = (...args) => { errors.push(args); handleError(...args); };
      try {
        await crawler.init;
        const retryResource = phase === 'retry' ? resource.createResource({
          type: resource.ResourceType.Html, depth: 0, url: 'https://example.test/index.html',
          refUrl: 'https://example.test/', localRoot: output
        }) : undefined;
        if (retryResource) assert.equal(crawler.addProcessedResource(retryResource), true);
        crawler.start();
        if (phase === 'cancel') {
          const deadline = Date.now() + 10000;
          while (true) {
            try { await fs.access(ready); break; }
            catch {
              assert.ok(Date.now() < deadline, 'Cancellation hook did not start');
              await delay(10);
            }
          }
          await crawler.dispose();
        } else {
          await crawler.onIdle();
          if (retryResource) {
            assert.equal(errors.length, 1, 'Expected the first attempt to fail');
            assert.equal(crawler.outcomes.get(retryResource.url).status, 'failed');
            assert.equal(retryResource.meta.doc, undefined, 'Retry retained a disposed document');
            assert.equal(crawler.addProcessedResource(retryResource), true, 'Retry was not admitted');
            await crawler.onIdle();
            assert.equal(errors.length, 1, 'Retry failed');
            assert.equal(crawler.outcomes.get(retryResource.url).status, 'saved');
            assert.equal(crawler.outcomes.get(retryResource.url).attempt, 2);
            assert.equal(retryResource.meta.doc, undefined);
          } else if (phase.endsWith('failure')) assert.ok(errors.length, 'Expected injected failure');
          else assert.equal(errors.length, 0, String(errors));
          if (phase === 'success' || phase === 'retry') {
            const html = await fs.readFile(path.join(output, 'example.test/index.html'), 'utf8');
            assert.ok(html.includes('data-owned="yes"'));
            assert.ok(html.includes('srcdoc='));
            assert.ok((await fs.readFile(path.join(output, 'example.test/child.html'), 'utf8')).includes('child resource'));
          }
        }
      } finally { await crawler.dispose(); }
      for (const event of ['start', 'resumed', 'following']) {
        assert.equal(statusEvents.filter(record => record.event === event).length, errors.length,
          mode + '/' + phase + ': incomplete asynchronous error status listener: ' + event);
      }
      const records = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const active = new Map();
      for (const record of records) {
        if (record.event === 'init') {
          assert.deepEqual(record.options, {heap: 'pool', poolSize: 2, poolMaxBytes});
        } else {
          const key = record.threadId + ':' + record.id;
          const count = active.get(key) ?? 0;
          if (record.event === 'load') { assert.equal(count, 0); active.set(key, 1); }
          else { assert.equal(count, 1, 'Document disposed more than once'); active.set(key, 0); }
        }
      }
      assert.ok([...active.values()].every(count => count === 0), mode + '/' + phase + ' leaked a document');
      console.log(mode + '/' + phase + ': document ownership and pool controls passed');
    }
  }
} finally { await fs.rm(root, {recursive: true, force: true}); }
