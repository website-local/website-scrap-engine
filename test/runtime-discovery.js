import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
const {downloader, resource} = await import(entry);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-discovery-'));
const deadline = setTimeout(() => { throw new Error('Discovery checks timed out'); }, 30000);
deadline.unref();
try {
  for (const Downloader of [downloader.SingleThreadDownloader, downloader.MultiThreadDownloader]) {
    for (const mode of ['limit', 'failed-parent', 'oversized-child', 'duplicate-limit', 'rejected-size-limit',
      'child-document', 'uncloneable-child-document']) {
      const documentMode = mode.endsWith('child-document');
      const output = path.join(root, Downloader.name, mode);
      await fs.mkdir(output, {recursive: true});
      const config = path.join(output, 'options.mjs');
      await fs.writeFile(config, `
import assert from 'node:assert/strict';
import {isMainThread} from 'node:worker_threads';
import {lifeCycle, loadHtml, options, resource} from ${JSON.stringify(entry)};
import fixture from ${JSON.stringify(new URL('./grovedom-fixture.cjs', import.meta.url).href)};
const lc = lifeCycle.defaultLifeCycle();
let previousSubmit;
lc.processBeforeDownload.unshift(res => {
  if (${documentMode} && res.url.endsWith('/child-1')) {
    res.meta.doc = loadHtml(res.body, undefined, undefined, {loadHtml: fixture.load});
  }
  return res;
});
lc.dispose.push(() => {
  assert.ok(fixture.state.documents.every(doc => doc.closed && doc.disposals === 1),
    'pre-download child documents must be disposed exactly once');
});
lc.processAfterDownload.unshift(async (res, submit, _options, pipeline) => {
  if (previousSubmit) assert.equal(submit, previousSubmit);
  previousSubmit = submit;
  if (!res.url.endsWith('/parent')) return res;
  const make = id => ({...resource.createResource({
    type: ${documentMode} ? resource.ResourceType.Html : resource.ResourceType.Binary, depth: 1,
    url: 'https://example.test/child-' + id, refUrl: res.url, localRoot: res.localRoot}),
    body: ${documentMode} ? '<p>child</p>' : 'child'});
  if (${documentMode}) {
    const child = await pipeline.processBeforeDownload(make(1), null, res);
    assert.equal(typeof child.meta.doc, 'function');
    if (${JSON.stringify(mode)} === 'uncloneable-child-document') child.meta.uncloneable = () => {};
    const document = child.meta.doc;
    const record = fixture.state.documents[fixture.state.documents.length - 1];
    try {
      submit(child, res, pipeline);
    } finally {
      if (isMainThread) assert.equal(child.meta.doc, document);
      else {
        assert.ok(child.meta.doc === undefined, 'worker must release the submitted child document');
        assert.deepEqual(record, {closed: true, disposals: 1});
      }
    }
    assert.equal(res.discoveredCount, 1);
    return res;
  }
  if (${JSON.stringify(mode)} === 'duplicate-limit') {
    const child = make(1);
    submit([child, make(1), make(2)], res, pipeline);
    assert.equal(res.discoveredCount, 3);
    return res;
  }
  const first = make(1);
  if (${JSON.stringify(mode)} === 'rejected-size-limit') first.body = Buffer.alloc(17);
  submit([first, make(2)], res, pipeline);
  if (${JSON.stringify(mode)} === 'failed-parent') throw new Error('parent processing failed');
  const third = make(3);
  if (${JSON.stringify(mode)} === 'oversized-child') third.body = Buffer.alloc(17);
  let disposed = 0;
  third.meta.doc = {dispose() { ++disposed; }};
  submit(third, res, pipeline);
  assert.equal(res.discoveredCount, 3);
  assert.equal(third.shouldBeDiscardedFromDownload, true);
  assert.equal(third.meta.error, undefined);
  assert.equal(disposed, 1);
  assert.equal(third.meta.doc, undefined);
  return res;
});
export default options.defaultDownloadOptions({...lc, initialUrl: [],
  localRoot: ${JSON.stringify(output)}, concurrency: 1, workerCount: 1,
  maxDiscoveredResources: ${['limit', 'duplicate-limit', 'rejected-size-limit'].includes(mode) ? 2 : 'undefined'},
  maxResourceBytes: ${documentMode ? 1024 : 16},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
      const crawler = new Downloader(pathToFileURL(config).href);
      try {
        await crawler.init;
        const url = 'https://example.test/parent';
        const parent = {...resource.createResource({type: resource.ResourceType.Binary,
          depth: 0, url, refUrl: url, localRoot: output}), body: 'parent'};
        assert.equal(crawler.addProcessedResource(parent), true);
        await crawler.start();
        await crawler.onIdle();
        const uncloneable = mode === 'uncloneable-child-document' && Downloader === downloader.MultiThreadDownloader;
        const successfulParent = mode !== 'failed-parent' && !uncloneable;
        assert.equal(crawler.outcomes.get(url).status, successfulParent ? 'saved' : 'failed', parent.meta.error?.message);
        if (successfulParent) assert.equal(parent.meta.error, undefined);
        if (uncloneable) assert.equal(parent.meta.error.name, 'DataCloneError');
        const ids = uncloneable ? [] : documentMode || mode === 'duplicate-limit' ? [1] :
          mode === 'rejected-size-limit' ? [2] : [1, 2];
        assert.equal(crawler.downloadedCount, ids.length + (successfulParent ? 1 : 0));
        assert.equal(crawler.outcomes.size, ids.length + 1);
        assert.equal(parent.discoveredCount, undefined);
        for (const id of ids) {
          assert.equal(crawler.outcomes.get('https://example.test/child-' + id).status, 'saved');
          const saved = await fs.readFile(path.join(output, 'example.test',
            'child-' + id + (documentMode ? '.html' : '')), 'utf8');
          if (documentMode) assert.ok(saved.includes('<p>child</p>'));
          else assert.equal(saved, 'child');
        }
      } finally { await crawler.dispose(); }
    }
  }
  console.log(`${process.version}: shared discovery, counted discards, failed parents and child document ownership pass`);
} finally {
  clearTimeout(deadline);
  await fs.rm(root, {recursive: true, force: true});
}
