import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {load} from 'cheerio';

// Usage: node --expose-gc scripts/benchmark-mdn-links.mjs HTML_FIXTURE
//   ENGINE_ENTRY MDN_LIFECYCLE [ENGINE_ENTRY MDN_LIFECYCLE ...]
// Each MDN lifecycle must import its matching engine; adapt the legacy save-path
// callback with wrapLegacyGenerateSavePath when preparing a 0.10 lifecycle.
const [fixture, ...entries] = process.argv.slice(2);
assert.ok(fixture && entries.length >= 2 && entries.length % 2 === 0);
const html = await fs.readFile(fixture, 'utf8');
const doc = load(html);
const elements = doc('a[href],img[src]');
assert.ok(elements.length > 0, 'fixture must contain links');
const variants = [];
for (let index = 0; index < entries.length; index += 2) {
  const api = await import(pathToFileURL(path.resolve(entries[index])).href);
  const {default: base} = await import(pathToFileURL(path.resolve(entries[index + 1])).href);
  const options = {...base, meta: {...base.meta, locale: 'en-US'},
    localRoot: path.resolve('mdn-benchmark-output')};
  api.logger.setLogger({trace() {}, debug() {}, info() {}, warn() {}, error() {},
    isTraceEnabled() { return false; }});
  variants.push({name: index / 2, api, options,
    pipeline: new api.downloader.PipelineExecutorImpl(options, options.req, options)});
}
const results = [];
let expected;
for (let sample = -1; sample < 5; sample++) {
  const order = sample % 2 === 1 ? [...variants].reverse() : variants;
  for (const {name, api, options, pipeline} of order) {
    global.gc?.();
    const cpu = process.cpuUsage();
    const start = performance.now();
    const hash = createHash('sha256');
    let accepted = 0;
    for (let repeat = 0; repeat < 20; repeat++) {
      const parent = api.resource.createResource({type: 2, depth: 0,
        url: 'https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Using_images',
        refUrl: 'https://developer.mozilla.org/en-US/', localRoot: options.localRoot});
      for (let index = 0; index < elements.length; index++) {
        const element = elements.eq(index);
        const url = element.attr('href') ?? element.attr('src');
        const res = await pipeline.createAndProcessResource(url,
          element.attr('href') ? 2 : 1, 1, element, parent);
        if (res) {
          ++accepted;
          hash.update(JSON.stringify([res.url, res.downloadLink, res.savePath,
            res.replacePath, !!res.shouldBeDiscardedFromDownload]));
        }
      }
    }
    const ms = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const sha256 = hash.digest('hex');
    if (expected) assert.equal(sha256, expected, 'rewritten URLs and paths must match');
    else expected = sha256;
    if (sample >= 0) results.push({name, sample, ms,
      cpuMs: (used.user + used.system) / 1000, links: elements.length * 20, accepted, sha256});
    process.stderr.write(`${name} ${sample} ${ms.toFixed(1)}ms\n`);
  }
}
console.log(JSON.stringify({node: process.version, entries, fixture,
  fixtureSha256: createHash('sha256').update(html).digest('hex'), results}, null, 2));
