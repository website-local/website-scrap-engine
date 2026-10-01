import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const entries = process.argv.slice(2);
if (!entries.length) entries.push('node_modules/p-queue/dist/index.js');
const variants = await Promise.all(entries.map(async entry => {
  const url = pathToFileURL(path.resolve(entry)).href;
  return {entry: url, Queue: (await import(url)).default};
}));
const results = [];
for (const workload of ['immediate', 'yielding']) {
  const count = workload === 'immediate' ? 20000 : 5000;
  for (let sample = -1; sample < 5; sample++) {
    const order = variants.map((_, index) => index);
    if (sample % 2 === 1) order.reverse();
    for (const variant of order) {
      global.gc?.();
      const queue = new variants[variant].Queue({concurrency: 32, autoStart: false});
      let completed = 0;
      let active = 0;
      let peakActive = 0;
      const started = performance.now();
      const tasks = Array.from({length: count}, () => queue.add(async () => {
        peakActive = Math.max(peakActive, ++active);
        if (workload === 'yielding') await new Promise(resolve => setImmediate(resolve));
        --active;
        ++completed;
      }));
      assert.equal(completed, 0, 'paused queue must not execute tasks');
      queue.start();
      await Promise.all(tasks);
      await queue.onIdle();
      const milliseconds = performance.now() - started;
      assert.equal(completed, count);
      assert.ok(peakActive <= 32);
      assert.equal(queue.pending, 0);
      assert.equal(queue.size, 0);
      if (sample >= 0) results.push({variant, workload, sample, count, milliseconds, peakActive});
    }
  }
}
console.log(JSON.stringify({node: process.version, entries: variants.map(variant => variant.entry),
  concurrency: 32, warmupsPerCase: 1, samples: 5, results}, null, 2));
