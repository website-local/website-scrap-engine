import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {lifeCycle, options} from '../lib/index.js';

if (!global.gc) throw new Error('Run with node --expose-gc');
const batchSize = 2000;
const hook = () => {};
let config = options.defaultDownloadOptions({...lifeCycle.defaultLifeCycle(),
  localRoot: 'unused', req: {retry: {limit: 0}, hooks: {beforeRequest: [hook]}}});
const samples = [];
const start = performance.now();
for (let batch = 0; batch < 6; batch++) {
  for (let index = 0; index < batchSize; index++) {
    config = options.mergeOverrideOptions(config, {
      req: {headers: {'x-request': String(index)}}
    });
  }
  global.gc();
  samples.push(process.memoryUsage());
  assert.deepEqual(config.req.hooks.beforeRequest, [hook]);
  assert.equal(Object.getPrototypeOf(config.req), Object.prototype);
  assert.equal('_init' in config.req, false);
  assert.equal('url' in config.req, false);
}
const retainedGrowth = samples.at(-1).heapUsed - samples[1].heapUsed;
// A broad noise allowance; the raw measurements accompany the audit.
assert.ok(retainedGrowth < 4 * 1024 * 1024, 'Options retain growing request history');
const result = {node: process.version, iterations: batchSize * 6,
  milliseconds: performance.now() - start, retainedGrowth, samples};
if (process.argv[2]) {
  const {default: Options} = await import(pathToFileURL(path.resolve(process.argv[2])).href);
  let previous = new Options();
  for (let index = 0; index < 1000; index++) {
    previous = new Options({headers: {'x-request': String(index)}}, undefined, previous);
  }
  // Reproduce the historical bug in the old version, never production code.
  result.legacyHistoryEntries = previous._init.length;
  assert.ok(result.legacyHistoryEntries >= 1000);
}
console.log(JSON.stringify(result, null, 2));
