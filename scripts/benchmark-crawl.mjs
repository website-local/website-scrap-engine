import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance, monitorEventLoopDelay} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';

// Entries are compared in alternating order; each gets a discarded warm-up.
// Run with TMPDIR inside the repository or its configured external artifact root.
const entries = process.argv.slice(2);
if (!entries.length) entries.push(new URL('../lib/index.js', import.meta.url).pathname);
const samples = Number(process.env.WSE_BENCH_SAMPLES ?? 5);
assert.ok(Number.isSafeInteger(samples) && samples > 0);
// Optional parent-thread profiles cover initialization through disposal, excluding
// fixture setup, output hashing and cleanup. Profiled timings are diagnostic only.
const profileDirectory = process.env.WSE_BENCH_CPU_PROFILE_DIR;
const InspectorSession = profileDirectory ? (await import('node:inspector/promises')).Session : undefined;
if (profileDirectory) await fs.mkdir(profileDirectory, {recursive: true});
const maxBufferedBytes = process.env.WSE_BENCH_BUFFER_BYTES === undefined ? undefined :
  Number(process.env.WSE_BENCH_BUFFER_BYTES);
assert.ok(maxBufferedBytes === undefined || Number.isSafeInteger(maxBufferedBytes) && maxBufferedBytes > 0);
const variants = await Promise.all(entries.map(async entry => {
  const url = pathToFileURL(path.resolve(entry)).href;
  return {entry: url, api: await import(url)};
}));
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-crawl-bench-'));
const bytes = Buffer.alloc(256 * 1024, 97);
const documents = 24;
const binaryCount = 48;
let requests = 0;
const server = createServer((request, response) => {
  ++requests;
  response.setHeader('Connection', 'close');
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const id = Number(pathname.match(/\d+/)?.[0] ?? 0);
  if (pathname.endsWith('.html')) {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<html><head><link rel="stylesheet" href="/style-${id}.css"></head><body>` +
      `<img src="/icon-${id}.svg">` +
      Array.from({length: 100}, () => `<img src="/asset-${id}.bin">`).join('') + '</body></html>');
  } else if (pathname.endsWith('.css')) {
    response.setHeader('Content-Type', 'text/css');
    response.end(Array.from({length: 100}, (_, index) =>
      `.x${index}{background:url('/asset-${id}.bin')}`).join('\n'));
  } else if (pathname.endsWith('.svg')) {
    response.setHeader('Content-Type', 'image/svg+xml');
    response.end(`<svg xmlns="http://www.w3.org/2000/svg"><image href="/asset-${id}.bin"/></svg>`);
  } else {
    response.setHeader('Content-Type', 'application/octet-stream');
    response.end(pathname.startsWith('/stream-') ? bytes : bytes.subarray(0, 65536));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const source = path.join(root, 'source.bin');
await fs.writeFile(source, bytes.subarray(0, 65536));
const deadline = setTimeout(() => { throw new Error('Crawl benchmark timed out'); }, 600000);
deadline.unref();
const results = [];
const expectedHashes = new Map();
const workloads = process.env.WSE_BENCH_WORKLOADS?.split(',') ?? ['buffered', 'streamed', 'local', 'markup'];
const modes = process.env.WSE_BENCH_MODES?.split(',') ?? ['SingleThreadDownloader', 'MultiThreadDownloader'];
assert.ok(workloads.every(value => ['buffered', 'streamed', 'local', 'markup'].includes(value)));
assert.ok(modes.every(value => ['SingleThreadDownloader', 'MultiThreadDownloader'].includes(value)));

async function fingerprint(output, expectedCount, expectedBinaryBytes) {
  const files = (await fs.readdir(output, {recursive: true, withFileTypes: true}))
    .filter(item => item.isFile()).map(item => path.relative(output, path.join(item.parentPath, item.name))).sort();
  assert.equal(files.length, expectedCount, 'complete output file set');
  const hash = createHash('sha256');
  let outputBytes = 0;
  for (const file of files) {
    assert.ok(!file.includes('.wse-stage-'), 'no leaked staging files');
    const content = await fs.readFile(path.join(output, file));
    if (file.endsWith('.bin')) assert.deepEqual(content, bytes.subarray(0, expectedBinaryBytes));
    else assert.ok(!content.toString().includes(origin), 'links were rewritten locally');
    outputBytes += content.length;
    hash.update(file.split(path.sep).join('/')).update('\0').update(content);
  }
  return {sha256: hash.digest('hex'), files: files.length, outputBytes};
}

async function run(variant, workload, mode, sample) {
  const {api, entry} = variants[variant];
  const caseRoot = path.join(root, `${variant}-${workload}-${mode}-${sample}`);
  const output = path.join(caseRoot, 'output');
  await fs.mkdir(caseRoot);
  const config = path.join(caseRoot, 'options.mjs');
  await fs.writeFile(config, `
import {lifeCycle, options} from ${JSON.stringify(entry)};
export default options.defaultDownloadOptions({...lifeCycle.defaultLifeCycle(),
  localRoot: ${JSON.stringify(output)}, initialUrl: [], concurrency: 8, workerCount: 2, maxDepth: 2,
  maxBufferedBytes: ${maxBufferedBytes ?? 'undefined'},
  req: {retry: {limit: 0}, timeout: {request: 10000}},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
  global.gc?.();
  const before = process.memoryUsage();
  let peakRss = before.rss;
  const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  const lag = monitorEventLoopDelay({resolution: 10});
  lag.enable();
  requests = 0;
  const errors = [];
  const profiler = InspectorSession && sample >= 0 ? new InspectorSession() : undefined;
  if (profiler) {
    profiler.connect();
    await profiler.post('Profiler.enable');
    await profiler.post('Profiler.setSamplingInterval', {interval: 250});
    await profiler.post('Profiler.start');
  }
  const cpu = process.cpuUsage();
  const started = performance.now();
  const crawler = new api.downloader[mode](pathToFileURL(config).href);
  const originalError = crawler.handleError.bind(crawler);
  crawler.handleError = (...args) => { errors.push(args); originalError(...args); };
  let initialized;
  let completed;
  const admitted = [];
  try {
    await crawler.init;
    crawler.stop(); // 0.9.1 starts automatically; both variants now admit while paused.
    initialized = performance.now();
    const count = workload === 'markup' ? documents : binaryCount;
    for (let id = 0; id < count; id++) {
      const suffix = workload === 'markup' ? `page-${id}.html` :
        workload === 'streamed' ? `stream-${id}.bin` : `asset-${id}.bin`;
      const url = origin + '/' + suffix;
      const res = api.resource.createResource({
        type: workload === 'markup' ? api.resource.ResourceType.Html :
          workload === 'streamed' ? api.resource.ResourceType.StreamingBinary : api.resource.ResourceType.Binary,
        depth: 0, url, refUrl: url, localRoot: output
      });
      if (workload === 'local') res.downloadLink = pathToFileURL(source).href;
      admitted.push(res);
      crawler.addProcessedResource(res);
    }
    await crawler.start();
    await crawler.onIdle();
    completed = performance.now();
    assert.deepEqual(errors, []);
    if (crawler.options.httpTransport === 'native' && workload !== 'local') {
      assert.ok(admitted.every(resource => resource.meta.httpTransport === 'native'),
        'native benchmark must exercise the native transport');
    }
    if (crawler.outcomes) assert.ok([...crawler.outcomes.values()].every(item => item.status === 'saved'));
  } catch (error) {
    profiler?.disconnect();
    throw error;
  } finally {
    await crawler.dispose();
    clearInterval(memoryTimer);
    lag.disable();
  }
  const finished = performance.now();
  const cpuUsed = process.cpuUsage(cpu);
  if (profiler) {
    try {
      const {profile} = await profiler.post('Profiler.stop');
      await fs.writeFile(path.join(profileDirectory,
        `${variant}-${workload}-${mode}-${sample}.cpuprofile`), JSON.stringify(profile));
    } finally { profiler.disconnect(); }
  }
  assert.equal(requests, workload === 'local' ? 0 : workload === 'markup' ? documents * 4 : binaryCount);
  const outputFingerprint = await fingerprint(output, workload === 'markup' ? documents * 4 : binaryCount,
    workload === 'streamed' ? bytes.length : 65536);
  const expected = expectedHashes.get(workload);
  if (expected) assert.deepEqual(outputFingerprint, expected, 'identical output across modes, samples and versions');
  else expectedHashes.set(workload, outputFingerprint);
  const result = {variant, workload, mode, sample, totalMs: finished - started,
    initializationMs: initialized - started, crawlMs: completed - initialized, disposalMs: finished - completed,
    cpuMs: (cpuUsed.user + cpuUsed.system) / 1000, peakRss, rssBefore: before.rss,
    eventLoopP99Ms: lag.percentile(99) / 1e6, requests, ...outputFingerprint};
  await fs.rm(caseRoot, {recursive: true, force: true});
  process.stderr.write(`${variant} ${workload} ${mode} sample=${sample} ${result.totalMs.toFixed(1)}ms\n`);
  return result;
}

try {
  for (const workload of workloads) {
    for (const mode of modes) {
      for (let sample = -1; sample < samples; sample++) {
        const order = variants.map((_, index) => index);
        // Rotate multi-version comparisons so no version is always in the middle.
        if (order.length > 2 && sample >= 0) order.push(...order.splice(0, sample % order.length));
        if ((order.length > 2 ? Math.floor(sample / order.length) : sample) % 2 === 1) order.reverse();
        for (const variant of order) {
          const result = await run(variant, workload, mode, sample);
          if (sample >= 0) results.push(result);
        }
      }
    }
  }
  console.log(JSON.stringify({node: process.version, platform: process.platform, arch: process.arch,
    entries: variants.map(variant => variant.entry), samples, concurrency: 8, workerCount: 2,
    documents, binaryCount, binaryBytes: 65536, streamingBytes: bytes.length,
    maxBufferedBytes,
    warmupsPerCase: 1, gcExposed: !!global.gc, parentCpuProfiles: !!profileDirectory, results}, null, 2));
} finally {
  clearTimeout(deadline);
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fs.rm(root, {recursive: true, force: true});
}
