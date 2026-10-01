import assert from 'node:assert/strict';
import {createServer, get} from 'node:http';
import {Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Isolate transport costs from output publication and resource processing.
// Arguments are Got module entries. Same connection policy as benchmark-crawl.
const entries = process.argv.slice(2);
assert.ok(entries.length);
const clients = await Promise.all(entries.map(async entry =>
  (await import(pathToFileURL(path.resolve(entry)).href)).default));
const requestOptions = {retry: {limit: 0}, timeout: {request: 10000}};
const variants = clients.flatMap((got, entry) => [
  {got, entry, preconfigured: false},
  ...process.env.WSE_BENCH_PRECONFIGURED ?
    [{got: got.extend(requestOptions), entry, preconfigured: true}] : []
]);
if (process.env.WSE_BENCH_NATIVE) variants.push({got: undefined, entry: 'native-http', preconfigured: false});
const samples = Number(process.env.WSE_BENCH_SAMPLES ?? 15);
assert.ok(Number.isSafeInteger(samples) && samples > 0);
const bytes = Buffer.alloc(256 * 1024, 97);
let requests = 0;
const server = createServer((request, response) => {
  requests++;
  response.setHeader('Connection', 'close');
  response.end(request.url === '/streamed' ? bytes : bytes.subarray(0, 65536));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const workload of ['buffered', 'streamed']) {
    const expected = workload === 'buffered' ? 65536 : bytes.length;
    for (let sample = -1; sample < samples; sample++) {
      const order = variants.map((_, index) => index);
      if (sample % 2 === 1) order.reverse();
      for (const variant of order) {
        global.gc?.();
        requests = 0;
        let next = 0;
        const cpu = process.cpuUsage();
        const started = performance.now();
        const {got, preconfigured} = variants[variant];
        await Promise.all(Array.from({length: 8}, async () => {
          while (next++ < 48) {
            const options = preconfigured ? {} : requestOptions;
            if (!got) {
              // Lower-bound probe only: no redirects, retries, decoding or hooks.
              const response = await new Promise((resolve, reject) => {
                get(origin + '/' + workload, resolve).once('error', reject);
              });
              let size = 0;
              const chunks = [];
              await pipeline(response, new Writable({write(chunk, _encoding, callback) {
                size += chunk.length;
                if (workload === 'buffered') chunks.push(chunk);
                assert.deepEqual(chunk, bytes.subarray(0, chunk.length));
                callback();
              }}));
              assert.equal(size, expected);
              if (workload === 'buffered') assert.deepEqual(Buffer.concat(chunks), bytes.subarray(0, expected));
            } else if (workload === 'buffered') {
              const response = await got(origin + '/buffered', {...options, responseType: 'buffer'});
              assert.deepEqual(Buffer.from(response.body), bytes.subarray(0, expected));
            } else {
              let size = 0;
              await pipeline(got.stream(origin + '/streamed', options), new Writable({
                write(chunk, _encoding, callback) {
                  size += chunk.length;
                  assert.deepEqual(chunk, bytes.subarray(0, chunk.length));
                  callback();
                }
              }));
              assert.equal(size, expected);
            }
          }
        }));
        const milliseconds = performance.now() - started;
        const used = process.cpuUsage(cpu);
        assert.equal(requests, 48);
        if (sample >= 0) results.push({variant, workload, sample, milliseconds,
          cpuMs: (used.user + used.system) / 1000, requests});
      }
    }
  }
  console.log(JSON.stringify({node: process.version, entries,
    variants: variants.map(({entry, preconfigured}) => ({entry, preconfigured})), samples, concurrency: 8,
    warmups: 1, requestsPerSample: 48, results}, null, 2));
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
