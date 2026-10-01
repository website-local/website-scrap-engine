import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
const {downloader, resource} = await import(entry);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-output-conflicts-'));
const deadline = setTimeout(() => { throw new Error('Output conflict checks timed out'); }, 30000);
deadline.unref();
try {
  for (const Downloader of [downloader.SingleThreadDownloader, downloader.MultiThreadDownloader]) {
    const output = path.join(root, Downloader.name);
    await fs.mkdir(output);
    const config = path.join(output, 'options.mjs');
    await fs.writeFile(config, `
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {lifeCycle, options} from ${JSON.stringify(entry)};
import {publishFile} from ${JSON.stringify(new URL('./output-store.js', entry).href)};
const lc = lifeCycle.defaultLifeCycle();
lc.saveToDisk = [async (res, opt, pipeline) => {
  await publishFile(path.join(res.localRoot, 'shared.bin'), async staging => {
    await fs.writeFile(staging, res.url);
    if (res.url.endsWith('/unpublished')) throw new Error('writer failed');
  }, pipeline.signal, res.localRoot);
  if (res.url.endsWith('/partial') && !res.meta.retry) throw new Error('later hook failed');
  return res;
}];
export default options.defaultDownloadOptions({...lc, initialUrl: [],
  localRoot: ${JSON.stringify(output)}, concurrency: 2, workerCount: 2,
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
    const crawler = new Downloader(pathToFileURL(config).href);
    const make = suffix => {
      const url = 'https://example.test/' + suffix;
      return {...resource.createResource({type: resource.ResourceType.Binary, depth: 0,
        url, refUrl: url, localRoot: output}), body: Buffer.from('body')};
    };
    try {
      await crawler.init;
      await crawler.start();
      const run = async res => {
        assert.equal(crawler.addProcessedResource(res), true);
        await crawler.onIdle();
        return crawler.outcomes.get(res.url);
      };
      assert.equal((await run(make('unpublished'))).status, 'failed');
      const partial = make('partial');
      const outcome = await run(partial);
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.publishedFiles, 1);
      const other = make('other');
      assert.equal((await run(other)).status, 'failed');
      assert.equal(other.meta.error.code, 'ERR_OUTPUT_CONFLICT');
      assert.equal(await fs.readFile(path.join(output, 'shared.bin'), 'utf8'), partial.url);
      const retry = make('partial');
      retry.meta.retry = true;
      const retried = await run(retry);
      assert.equal(retried.status, 'saved');
      assert.equal(retried.attempt, 2);
      assert.equal(crawler.downloadedCount, 1);
      assert.deepEqual((await fs.readdir(output)).filter(name => name.startsWith('.wse-stage-')), []);
    } finally { await crawler.dispose(); }
  }
  console.log(`${process.version}: destination conflicts, failed allocation release and owner retries pass in both modes`);
} finally {
  clearTimeout(deadline);
  await fs.rm(root, {recursive: true, force: true});
}
