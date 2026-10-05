import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Direct common URIjs APIs, without crawler work. One process per case:
// node --expose-gc benchmark-uri.mjs URIJS_ENTRY WRAPPER_ENTRY CASE OUTPUT_JSON [PREVIOUS_WRAPPER_ENTRY]
const [legacyEntry, wrapperEntry, selectedCase, output, previousEntry] = process.argv.slice(2);
assert.ok(legacyEntry && wrapperEntry && selectedCase && output);
assert.ok(global.gc, 'Run with --expose-gc');
const legacy = (await import(pathToFileURL(path.resolve(legacyEntry)))).default;
const candidate = (await import(pathToFileURL(path.resolve(wrapperEntry)))).URI;
const previous = previousEntry && selectedCase !== 'query-helpers' ?
  (await import(pathToFileURL(path.resolve(previousEntry)))).URI : undefined;
const apis = previous ? [legacy, previous, candidate, candidate] : [legacy, candidate, candidate];
const candidateIndex = apis.length - 2, controlIndex = apis.length - 1;
const variants = apis.map((_, i) => i === 0 ? 'urijs' : i === candidateIndex ? 'candidate' :
  i === controlIndex ? 'identical-candidate-control' : 'previous-wrapper');
const counts = {
  'parse-absolute': 100000, 'parse-relative': 100000, getters: 100000,
  clone: 200000, 'mutate-path-query-hash': 100000, 'mutate-authority': 100000,
  'mutate-path-query-hash-changing': 50000, 'mutate-authority-changing': 50000,
  'resolve-absolute': 50000, 'resolve-relative': 50000,
  'query-read': 50000, 'query-write': 50000, 'query-helpers': 20000
};
const operations = counts[selectedCase];
assert.ok(operations, 'Unknown case: ' + selectedCase);
const protocol = {
  variants,
  warmups: 2, calibrationRounds: 4, measuredRounds: 16,
  observationsPerVariantPerRound: 2, minimumRetainedRounds: 12,
  order: 'Rotate starting variant and reverse on alternate cycles; second observation reverses each order',
  filter: 'Reject whole round when maximum bracketing CPU probe exceeds 1.5 times median calibration maximum',
  probeOperations: 4000000, thresholdMultiplier: 1.5,
  bootstrapResamples: 10000, bootstrapSeed: 123456789,
  control: '95% interval includes zero and lies inside [-5,+5] percent',
  classification: 'Control must pass and both wrapper copies must agree on direction',
  stopping: 'Fixed rounds, no retries or threshold changes; abort on output mismatch',
  timing: 'Warm direct API batches; inputs/pools and forced GC outside timing; result consumption inside timing',
  semantics: 'Canonical equivalent inputs only; does not cover known WHATWG/URIjs behavior differences',
  host: 'Record host before/after; if busy, retain as diagnostic without waiting or retrying'
};

function prepare(URI) {
  const inputs = Array.from({length: 128}, (_, i) =>
    `https://example.org:8080/docs/section/file-${i}.html?x=a%20b&x=${i}&y=~#part-${i}`);
  const references = inputs.map((_, i) => `../images/icon-${i}.svg?x=${i}#part`);
  const objects = inputs.map(value => URI(value));
  const relativeObjects = references.map(value => URI(value));
  const base = URI('https://example.org:8080/docs/section/page.html');
  const targets = references.map((_, i) => URI(
    `https://example.org:8080/docs/images/icon-${i}.svg?x=${i}#part`));
  const functions = {
    'parse-absolute': i => URI(inputs[i & 127]).toString(),
    'parse-relative': i => URI(references[i & 127]).toString(),
    getters: i => {
      const u = objects[i & 127];
      return [u.protocol(), u.hostname(), u.port(), u.path(), u.search(),
        u.hash(), u.filename(), u.suffix()].join('|');
    },
    clone: i => objects[i & 127].clone().toString(),
    'mutate-path-query-hash': i => objects[i & 127]
      .path(`/assets/asset-${i & 127}.svg`).search('x=1&y=a%20b').hash('part').toString(),
    'mutate-authority': i => objects[i & 127]
      .protocol(i & 1 ? 'http' : 'https').hostname(`cdn-${i & 127}.example.org`)
      .port(8081).toString(),
    'mutate-path-query-hash-changing': i => objects[i & 127]
      .path(`/assets/asset-${i & 127}-${i >>> 7}.svg`).search('x=' + (i >>> 7)).hash('part-' + (i >>> 7)).toString(),
    'mutate-authority-changing': i => objects[i & 127]
      .protocol((i + (i >>> 7)) & 1 ? 'http' : 'https')
      .hostname(`cdn-${(i + (i >>> 7)) & 255}.example.org`).port(8081 + ((i >>> 7) & 1)).toString(),
    'resolve-absolute': i => relativeObjects[i & 127].absoluteTo(base).toString(),
    'resolve-relative': i => targets[i & 127].relativeTo(base).toString(),
    'query-read': i => JSON.stringify(objects[i & 127].query(true)),
    'query-write': i => objects[i & 127].query({x: ['first', 'value-' + (i & 127)], flag: 'yes'}).toString(),
    'query-helpers': i => objects[i & 127].query('x=1&x=2&flag')
      .addQuery('x', '3').setQuery('new', 'value-' + (i & 127)).removeQuery('x', '1').toString()
  };
  return functions[selectedCase];
}

const check = apis.map(prepare);
const correctness = createHash('sha256');
try {
  for (let i = 0; i < 256; i++) {
    const expected = check[0](i);
    for (let v = 1; v < check.length; v++) {
      assert.equal(check[v](i), expected, `preflight mismatch at ${i}, variant ${variants[v]}`);
    }
    correctness.update(expected).update('\0');
  }
} catch (error) {
  await writeFile(output, JSON.stringify({case: selectedCase, status: 'incompatible-output',
    protocol, error: String(error), actual: error.actual, expected: error.expected}, null, 2) + '\n');
  throw error;
}
if (process.env.WSE_URI_PREFLIGHT_ONLY === '1') {
  await writeFile(output, JSON.stringify({case: selectedCase, status: 'preflight-passed',
    variants, sha256: correctness.digest('hex')}, null, 2) + '\n');
  process.exit(0);
}
const work = apis.map(prepare);
let probeSink = 1;
function probe() {
  const started = performance.now();
  for (let i = 0; i < protocol.probeOperations; i++) {
    probeSink = Math.imul(probeSink ^ i, 1664525) + 1013904223 | 0;
  }
  return performance.now() - started;
}
for (let i = 0; i < 5; i++) probe();
let expectedChecksum;
function sample(variant) {
  global.gc();
  const noiseBefore = probe();
  const cpu = process.cpuUsage();
  const started = performance.now();
  let checksum = 0;
  const fn = work[variant];
  for (let i = 0; i < operations; i++) {
    const result = fn(i);
    checksum = (checksum + result.length + result.charCodeAt(i % result.length)) >>> 0;
  }
  const ms = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const noiseAfter = probe();
  if (expectedChecksum === undefined) expectedChecksum = checksum;
  assert.equal(checksum, expectedChecksum, 'batch checksum mismatch');
  return {variant, ms, cpuMs: (used.user + used.system) / 1000,
    noiseBefore, noiseAfter, checksum};
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
};
function interval(values) {
  let seed = protocol.bootstrapSeed;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const boot = Array.from({length: protocol.bootstrapResamples}, () =>
    median(values.map(() => values[Math.floor(random() * values.length)])))
    .sort((a, b) => a - b);
  const quantile = p => {
    const at = p * (boot.length - 1), lo = Math.floor(at);
    return boot[lo] + (boot[Math.ceil(at)] - boot[lo]) * (at - lo);
  };
  return {median: median(values), interval95: [quantile(.025), quantile(.975)]};
}
const record = {case: selectedCase, operations, protocol, node: process.version,
  versions: process.versions, legacyVersion: legacy.version, status: 'running',
  startedAt: new Date().toISOString(), preflightSha256: correctness.digest('hex'),
  inputHashes: {}, warmups: [], calibration: [], rounds: []};
for (const filename of [legacyEntry, wrapperEntry, previousEntry].filter(Boolean)) {
  record.inputHashes[path.resolve(filename)] = createHash('sha256')
    .update(await readFile(filename)).digest('hex');
}
const save = () => writeFile(output, JSON.stringify(record, null, 2) + '\n');
function round(index) {
  const order = apis.map((_, i) => i);
  order.push(...order.splice(0, index % apis.length));
  if (Math.floor(index / apis.length) % 2) order.reverse();
  const observations = [];
  for (let n = 0; n < 2; n++) {
    for (const variant of n ? [...order].reverse() : order) {
      observations.push({...sample(variant), observation: n});
    }
  }
  return {index, order, observations, noiseMaximum:
    Math.max(...observations.flatMap(row => [row.noiseBefore, row.noiseAfter]))};
}
try {
  for (let i = 0; i < protocol.warmups; i++) {
    const order = apis.map((_, v) => v);
    for (const v of i ? order.reverse() : order) record.warmups.push(sample(v));
  }
  for (let i = 0; i < protocol.calibrationRounds; i++) record.calibration.push(round(i));
  record.threshold = protocol.thresholdMultiplier *
    median(record.calibration.map(group => group.noiseMaximum));
  await save();
  for (let i = 0; i < protocol.measuredRounds; i++) {
    record.rounds.push(round(i));
    await save();
  }
  record.excludedRounds = record.rounds.filter(group => group.noiseMaximum > record.threshold)
    .map(group => group.index);
  const retained = record.rounds.filter(group => !record.excludedRounds.includes(group.index));
  record.retainedRounds = retained.length;
  record.status = 'unresolved-insufficient-rounds';
  if (retained.length >= protocol.minimumRetainedRounds) {
    const medians = retained.map(group => apis.map((_, variant) =>
      median(group.observations.filter(row => row.variant === variant).map(row => row.ms))));
    record.medianMs = apis.map((_, v) => median(medians.map(row => row[v])));
    record.wrapperPercent = interval(medians.map(row => 100 * (row[candidateIndex] / row[0] - 1)));
    record.secondWrapperPercent = interval(medians.map(row => 100 * (row[controlIndex] / row[0] - 1)));
    record.controlPercent = interval(medians.map(row => 100 * (row[controlIndex] / row[candidateIndex] - 1)));
    if (previous) {
      record.previousWrapperPercent = interval(medians.map(row => 100 * (row[candidateIndex] / row[1] - 1)));
      record.secondVsPreviousPercent = interval(medians.map(row => 100 * (row[controlIndex] / row[1] - 1)));
    }
    const [lo, hi] = record.controlPercent.interval95;
    record.controlPass = lo <= 0 && hi >= 0 && lo >= -5 && hi <= 5;
    record.status = !record.controlPass ? 'unresolved-control' :
      record.wrapperPercent.interval95[1] < 0 && record.secondWrapperPercent.interval95[1] < 0 ? 'faster' :
      record.wrapperPercent.interval95[0] > 0 && record.secondWrapperPercent.interval95[0] > 0 ? 'slower' :
        'unresolved-difference';
  }
  record.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({case: selectedCase, status: record.status,
    retained: record.retainedRounds, effect: record.wrapperPercent, control: record.controlPercent}));
} catch (error) {
  record.status = 'failed'; record.error = String(error); await save(); throw error;
}
