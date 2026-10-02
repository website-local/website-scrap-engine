import fs from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

// Usage: node --expose-gc scripts/benchmark-mdn-crawl.mjs HTML_FIXTURE
//   ENGINE_ENTRY MDN_LIFECYCLE [ENGINE_ENTRY MDN_LIFECYCLE ...]
// Compile each MDN variant against its matching engine before running. TMPDIR
// must point to an allowed artifact directory. This is a depth-zero CPU/I/O
// replay, not a network crawl: bootstrap downloads are omitted and every HTML
// acquisition uses the supplied saved document.
net.Socket.prototype.connect = function () { throw new Error('Network disabled in MDN replay'); };
const [fixture, ...entries] = process.argv.slice(2);
assert.ok(fixture && entries.length >= 2 && entries.length % 2 === 0);
const samples = Number(process.env.WSE_BENCH_SAMPLES ?? 5);
assert.ok(Number.isSafeInteger(samples) && samples > 0);
const variants = [];
for (let index = 0; index < entries.length; index += 2) {
  const api = await import(pathToFileURL(path.resolve(entries[index])).href);
  const lifecycle = pathToFileURL(path.resolve(entries[index + 1])).href;
  const {MdnDownloader} = await import(new URL('mdn-downloader.js', lifecycle));
  variants.push({name: index / 2, api, lifecycle, MdnDownloader});
}
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-mdn-replay-'));
const deadline = setTimeout(() => { throw new Error('MDN replay timed out'); },
  Math.max(120000, (samples + 1) * variants.length * 10000));
deadline.unref();
const results = [];
let expected;
try {
  for (let sample = -1; sample < samples; sample++) {
    const order = [...variants];
    if (order.length > 2 && sample >= 0) order.push(...order.splice(0, sample % order.length));
    if ((order.length > 2 ? Math.floor(sample / order.length) : sample) % 2 === 1) order.reverse();
    for (const {name, api, lifecycle, MdnDownloader} of order) {
      const caseRoot = await fs.mkdtemp(path.join(root, 'case-'));
      const output = path.join(caseRoot, 'output');
      const config = path.join(caseRoot, 'options.mjs');
      await fs.writeFile(config, `
import base from ${JSON.stringify(lifecycle)};
import {readFile} from 'node:fs/promises';
const html = await readFile(${JSON.stringify(path.resolve(fixture))}, 'utf8');
export default {...base, localRoot: ${JSON.stringify(output)}, initialUrl: [], init: [],
  maxDepth: 0, concurrency: 8, adjustConcurrencyPeriod: undefined,
  meta: {...base.meta, locale: 'en-US'},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {},
    isTraceEnabled() { return false; }}),
  download: [res => {
    res.body = res.type === 2 ? html : Buffer.from('fixture');
    res.meta.headers = {'content-type': res.type === 2 ? 'text/html' : 'application/octet-stream'};
    return res;
  }]
};
`);
      global.gc?.();
      const cpu = process.cpuUsage();
      const started = performance.now();
      const errors = [];
      const crawler = new MdnDownloader(pathToFileURL(config).href);
      crawler.handleError = (...args) => errors.push(args);
      try {
        await crawler.init;
        crawler.stop();
        for (let index = 0; index < 12; index++) {
          const url = 'https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Using_images_' + index;
          const res = await crawler.pipeline.createResource(api.resource.ResourceType.Html, 0, url, url);
          crawler.addProcessedResource(res);
        }
        await crawler.start();
        await crawler.onIdle();
        assert.deepEqual(errors, []);
      } finally { await crawler.dispose(); }
      const ms = performance.now() - started;
      const used = process.cpuUsage(cpu);
      const files = (await fs.readdir(output, {recursive: true, withFileTypes: true}))
        .filter(file => file.isFile())
        .map(file => path.relative(output, path.join(file.parentPath, file.name))).sort();
      assert.equal(files.length, 12);
      const hash = createHash('sha256');
      for (const file of files) {
        assert.ok(!file.includes('.wse-stage-'));
        hash.update(file.split(path.sep).join('/')).update('\0')
          .update(await fs.readFile(path.join(output, file)));
      }
      const sha256 = hash.digest('hex');
      if (expected) assert.equal(sha256, expected, 'complete output must match');
      else expected = sha256;
      const result = {name, sample, ms, cpuMs: (used.user + used.system) / 1000,
        files: files.length, sha256};
      if (sample >= 0) results.push(result);
      process.stderr.write(JSON.stringify(result) + '\n');
      await fs.rm(caseRoot, {recursive: true, force: true});
    }
  }
  console.log(JSON.stringify({node: process.version, entries, fixture, pages: 12, samples,
    fixtureSha256: createHash('sha256').update(await fs.readFile(fixture)).digest('hex'), results}, null, 2));
} finally {
  clearTimeout(deadline);
  await fs.rm(root, {recursive: true, force: true});
}
