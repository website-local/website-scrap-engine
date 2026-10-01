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
    for (const mode of ['limit', 'failed-parent', 'oversized-child', 'duplicate-limit']) {
      const output = path.join(root, Downloader.name, mode);
      await fs.mkdir(output, {recursive: true});
      const config = path.join(output, 'options.mjs');
      await fs.writeFile(config, `
import {lifeCycle, options, resource} from ${JSON.stringify(entry)};
const lc = lifeCycle.defaultLifeCycle();
if (${JSON.stringify(mode)} === 'duplicate-limit') lc.download.unshift(res => {
  if (!res.url.endsWith('/parent')) res.body = 'child';
  return res;
});
lc.processAfterDownload.unshift((res, submit) => {
  if (!res.url.endsWith('/parent')) return res;
  const make = id => ({...resource.createResource({type: resource.ResourceType.Binary, depth: 1,
    url: 'https://example.test/child-' + id, refUrl: res.url, localRoot: res.localRoot}), body: 'child'});
  if (${JSON.stringify(mode)} === 'duplicate-limit') {
    const child = make(1);
    delete child.body;
    submit([child, child, child]);
    return res;
  }
  submit([make(1), make(2)]);
  if (${JSON.stringify(mode)} === 'failed-parent') throw new Error('parent processing failed');
  const third = make(3);
  if (${JSON.stringify(mode)} === 'oversized-child') third.body = Buffer.alloc(17);
  submit(third);
  return res;
});
export default options.defaultDownloadOptions({...lc, initialUrl: [],
  localRoot: ${JSON.stringify(output)}, concurrency: 1, workerCount: 1,
  maxDiscoveredResources: ${mode === 'limit' || mode === 'duplicate-limit' ? 2 : 'undefined'}, maxResourceBytes: 16,
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
        assert.equal(crawler.outcomes.get(url).status, 'failed');
        if (mode === 'limit' || mode === 'duplicate-limit') assert.equal(parent.meta.error.code, 'ERR_DISCOVERY_LIMIT');
        if (mode === 'oversized-child') assert.equal(parent.meta.error.code, 'ERR_RESOURCE_SIZE_LIMIT');
        const ids = mode === 'duplicate-limit' ? [1] : [1, 2];
        assert.equal(crawler.downloadedCount, ids.length);
        assert.equal(crawler.outcomes.size, ids.length + 1);
        for (const id of ids) {
          assert.equal(crawler.outcomes.get('https://example.test/child-' + id).status, 'saved');
          assert.equal(await fs.readFile(path.join(output, 'example.test', 'child-' + id), 'utf8'), 'child');
        }
      } finally { await crawler.dispose(); }
    }
  }
  console.log(`${process.version}: discovery limits and failed-parent child outcomes pass in both modes`);
} finally {
  clearTimeout(deadline);
  await fs.rm(root, {recursive: true, force: true});
}
