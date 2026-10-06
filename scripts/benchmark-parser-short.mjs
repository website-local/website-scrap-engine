import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {setTimeout} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Short paired parser/query benchmark, with whole-round noise filtering and
// identical-code controls. Arguments: BEFORE_LIB AFTER_LIB CASE OUTPUT.
const [beforeDir, afterDir, selectedCase, output] = process.argv.slice(2);
assert.ok(output && global.gc, 'Provide four arguments and --expose-gc');
const beforeEntry = path.resolve(beforeDir, 'uri.js'), afterEntry = path.resolve(afterDir, 'uri.js');
const entries = [beforeEntry, beforeEntry, afterEntry];
// Baseline adapter for builds predating the separately exported extractor.
function legacyRefresh(value) {
  const match = /^\s*(\d+)(?:\s*;(?:\s*url\s*=)?\s*(?:["']\s*(.*?)\s*['"]|(.*?)))?\s*$/i.exec(value);
  return match?.[2] || match?.[3] || undefined;
}
async function load(entry) {
  const dir = path.dirname(entry);
  const [uri, css, meta, query] = await Promise.all([entry,
    path.join(dir, 'life-cycle/parse-css-urls.js'), path.join(dir, 'life-cycle/process-html-meta.js'),
    path.join(dir, 'uri-query.js')].map(file => import(pathToFileURL(file))));
  return {URI:uri.default, css:css.parseCssUrlMatches, refresh:meta.parseRefreshLink ?? legacyRefresh, query};
}
const apis = await Promise.all(entries.map(load));
apis.push(apis[2]);
const variants = ['identical-before-control', 'before', 'after', 'identical-after-control'];
const batching = false;
const protocol = {
  targetSlowestBatchMs: 8, minimumOperations: 128,
  maximumOperations: 32768,
  warmupOperations: 2048, sizingOperations: 256,
  operationQuantum: 32,
  calibrationRounds: 4, measuredRounds: 12, minimumRetained: 8,
  order: 'Rotate four variants, alternate direction; reverse order for second observation',
  probes: '250000 integer operations before and after each batch; no profiling during timing',
  filter: 'Whole round rejected above 1.5x median calibration maximum probe or 250ms round wall time',
  control: 'Bootstrap 95% interval contains zero and lies inside [-5,+5] percent',
  bootstrapResamples: 10000, bootstrapSeed: 123456789,
  idle: 'Before each measured round, up to ten 20ms waits until probe <=1.2x calibration median maximum; no measured-round retries',
  gc: 'One forced GC before each whole round, outside probes and timing',
  consumption: 'Length and changing character checksum inside timing; exact preflight and equal batch checksums',
};


function prepare(api) {
  const css = Array.from({length: 12}, (_, i) => `/* ${i} */ .a${i}{x:url("image-${i}.png");y:url(icon-${i}.svg)} `).join('');
  const text = Array.from({length: 12}, (_, i) => `See https://example.org/a-${i} `).join('');
  const genericText = text.replaceAll('https:', 'custom:');
  const uri = api.URI('https://example.org/base/');
  const actual = Array.from({length: 128}, (_, i) => String(i));
  const wanted = [...actual].reverse(), removed = wanted.slice(0, 64);
  const one = api.URI('https://e/?' + actual.map(x => 'x=' + x).join('&'));
  const two = api.URI('https://e/?' + wanted.map(x => 'x=' + x).join('&'));
  const cases = {
    'css-small': i => {const m=api.css(`a{x:url("image-${i & 7}.png")}`);return m[0].url;},
    'css-sheet': () => {const m=api.css(css);return m.length + ':' + m.at(-1).url;},
    'refresh-raw': i => api.refresh(`0; url=https://example.org/a-${i & 7}`),
    'within-generic': () => api.URI.withinString(genericText, () => {}),
    'refresh': i => api.refresh(`0; url=" https://example.org/a-${i & 7} "`),
    'within-observe': () => api.URI.withinString(text, () => {}),
    'within-replace': () => api.URI.withinString(text, () => 'local/a'),
    'query-match': () => String(api.query.hasQuery({x:actual}, 'x', wanted)),
    'query-remove': () => api.query.removeQuery({x:actual}, 'x', removed).x.join(','),
    'uri-equals': () => String(one.equals(two)),
    'segment': i => uri.segment(-1, `//asset-${i & 7}//`).href(),
  };
  assert.ok(cases[selectedCase], 'Unknown case');
  return cases[selectedCase];
}

const median = values => {
  const v = [...values].sort((a,b) => a-b);
  return (v[(v.length-1)>>1] + v[v.length>>1])/2;
};
function interval(values) {
  let seed = protocol.bootstrapSeed;
  const random = () => { seed ^= seed<<13; seed ^= seed>>>17; seed ^= seed<<5; return (seed>>>0)/4294967296; };
  const boot = Array.from({length:protocol.bootstrapResamples}, () =>
    median(values.map(() => values[Math.floor(random()*values.length)]))).sort((a,b) => a-b);
  return {median:median(values), interval95:[boot[250], boot[9749]]};
}

// For batching, both wrapper slots use the same implementation and inputs.
// Only the edit strategy changes; keep the identical-batch control independent.
if (batching) apis[1] = apis[2];
const preflight = apis.map(prepare), correctness = createHash('sha256');
for (let i=0;i<512;i++) {
  const expected = preflight[0](i);
  for (let v=1;v<4;v++) assert.equal(preflight[v](i), expected, 'Preflight ' + variants[v]);
  correctness.update(expected).update('\0');
}
const work = apis.map(prepare);
function batch(variant, operations) {
  const fn = work[variant];
  const cpu = process.cpuUsage(), start = performance.now();
  let checksum=0;
  for (let i=0;i<operations;i++) {
    const result=fn(i);
    checksum = (checksum + result.length + result.charCodeAt(i % result.length)) >>> 0;
  }
  const ms = performance.now()-start, used = process.cpuUsage(cpu);
  return {variant, operations, ms, cpuMs:(used.user+used.system)/1000, checksum};
}
let sink=1;
function probe() {
  const start=performance.now();
  for(let i=0;i<250000;i++) sink=Math.imul(sink^i,1664525)+1013904223|0;
  return performance.now()-start;
}
const record = {case:selectedCase, protocol, variants, node:process.version,
  comparison: 'after versus before, with identical-code controls for both',
  startedAt:new Date().toISOString(), preflightSha256:correctness.digest('hex'),
  hashes:{}, warmups:[], sizing:[], calibration:[], rounds:[], status:'running'};
for(const entry of [...entries, new URL(import.meta.url)]) {
  record.hashes[String(entry)] = createHash('sha256').update(await readFile(entry)).digest('hex');
}
for(const entry of [beforeEntry, afterEntry]) for(const file of ['uri-query.js', 'life-cycle/parse-css-urls.js', 'life-cycle/process-html-meta.js']) {
  const target = path.join(path.dirname(entry), file);
  record.hashes[target] = createHash('sha256').update(await readFile(target)).digest('hex');
}
try { record.linuxLoadBefore = (await readFile('/proc/loadavg','utf8')).trim(); } catch { /* Windows */ }
for(let n=0;n<12;n++) probe();
for(let v=0;v<4;v++) record.warmups.push(batch(v, protocol.warmupOperations));
for(let n=0;n<3;n++) for(let v=0;v<4;v++) record.sizing.push(batch(v,protocol.sizingOperations));
const slowest = Math.max(...apis.map((_,v) => median(record.sizing.filter(r => r.variant===v).map(r => r.ms))));
const operations = Math.max(protocol.minimumOperations, Math.min(protocol.maximumOperations,
  Math.floor(protocol.sizingOperations * protocol.targetSlowestBatchMs / slowest /
    protocol.operationQuantum)*protocol.operationQuantum));
record.operations = operations;
let checksum;
function round(index) {
  global.gc();
  const order=[0,1,2,3];order.push(...order.splice(0,index%4));
  if(Math.floor(index/4)%2) order.reverse();
  const observations=[], start=performance.now();
  for(const v of [...order,...[...order].reverse()]) {
    const before=probe(), observation=batch(v,operations), after=probe();
    checksum ??= observation.checksum;
    assert.equal(observation.checksum,checksum,'Batch checksum');
    observations.push({...observation,probeBefore:before,probeAfter:after});
  }
  return {index,order,wallMs:performance.now()-start, observations,
    noiseMaximum:Math.max(...observations.flatMap(o => [o.probeBefore,o.probeAfter]))};
}
const save = () => writeFile(output,JSON.stringify(record,null,2)+'\n');
try {
  for(let n=0;n<protocol.calibrationRounds;n++) { record.calibration.push(round(n)); await setTimeout(20); }
  record.threshold = 1.5 * median(record.calibration.map(r => r.noiseMaximum));
  record.idleThreshold = 1.2 * median(record.calibration.map(r => r.noiseMaximum));
  await save();
  for(let n=0;n<protocol.measuredRounds;n++) {
    const idleProbes=[];
    for(let attempt=0;attempt<10;attempt++) {
      await setTimeout(20);idleProbes.push(probe());
      if(idleProbes.at(-1)<=record.idleThreshold) break;
    }
    record.rounds.push({...round(n),idleProbes});await save();
  }
  record.excluded = record.rounds.filter(r => r.noiseMaximum>record.threshold || r.wallMs>250).map(r => r.index);
  const kept=record.rounds.filter(r => !record.excluded.includes(r.index));
  record.retained=kept.length;
  const medians=kept.map(r => apis.map((_,v) => median(r.observations.filter(o => o.variant===v).map(o => o.ms))));
  if(kept.length>=protocol.minimumRetained) {
    record.medianNs=apis.map((_,v) => median(medians.map(r => r[v]))*1e6/operations);
    record.beforePercent=interval(medians.map(r => 100*(r[2]/r[1]-1)));
    record.beforeControlPercent=interval(medians.map(r => 100*(r[3]/r[1]-1)));
    record.baselineReplicaPercent=interval(medians.map(r => 100*(r[2]/r[0]-1)));
    record.baselineReplicaControlPercent=interval(medians.map(r => 100*(r[3]/r[0]-1)));
    record.baselineControlPercent=interval(medians.map(r => 100*(r[0]/r[1]-1)));
    record.controlPercent=interval(medians.map(r => 100*(r[3]/r[2]-1)));
    const [lo,hi]=record.controlPercent.interval95;
    const [blo,bhi]=record.baselineControlPercent.interval95;
    record.controlPass=lo<=0 && hi>=0 && lo>=-5 && hi<=5 && blo<=0 && bhi>=0 && blo>=-5 && bhi<=5;
    const classification=(one,two) => !record.controlPass ? 'unresolved-control' :
      one.interval95[1]<0 && two.interval95[1]<0 ? 'faster' :
        one.interval95[0]>0 && two.interval95[0]>0 ? 'slower' : 'unresolved-difference';
    record.status=classification(record.beforePercent,record.beforeControlPercent);
    record.baselineReplicaStatus=classification(record.baselineReplicaPercent,record.baselineReplicaControlPercent);
  } else record.status='unresolved-insufficient-rounds';
  record.finishedAt=new Date().toISOString();
  try { record.linuxLoadAfter=(await readFile('/proc/loadavg','utf8')).trim(); } catch { /* Windows */ }
  await save();
  console.log(JSON.stringify({case:selectedCase,status:record.status,retained:record.retained,
    before:record.beforePercent,baselineReplica:record.baselineReplicaPercent,control:record.controlPercent,
    medianRoundMs:median(record.rounds.map(r => r.wallMs))}));
} catch(error) {
  record.status='failed';record.error=String(error);await save();throw error;
}
