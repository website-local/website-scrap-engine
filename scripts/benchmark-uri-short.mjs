import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {setTimeout} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Warm direct API calls, without the engine. Run one case per process:
// node --expose-gc scripts/benchmark-uri-short.mjs URIJS BEFORE AFTER CASE OUTPUT
const [legacyEntry, beforeEntry, afterEntry, selectedCase, output] = process.argv.slice(2);
assert.ok(output && global.gc, 'Provide all five arguments and --expose-gc');
const entries = [legacyEntry, beforeEntry, afterEntry];
const modules = await Promise.all(entries.map(entry => import(pathToFileURL(path.resolve(entry)))));
const apis = modules.map(mod => mod.URI ?? mod.default);
apis.push(apis[2]);
const variants = ['urijs', 'before', 'after', 'identical-after-control'];
const batching = selectedCase === 'query-batching';
if (batching) variants.splice(0, 4, 'urijs-chain', 'after-chain', 'after-batch', 'identical-after-batch-control');
const largeQuery = selectedCase === 'query-bare-read' || selectedCase === 'query-chain-long' || selectedCase === 'has-key-long';
const protocol = {
  targetSlowestBatchMs: 12, minimumOperations: largeQuery ? 16 : 512,
  maximumOperations: selectedCase === 'is-relative' ? 262144 : 16384,
  warmupOperations: largeQuery ? 2048 : 32768, sizingOperations: largeQuery ? 128 : 2048,
  operationQuantum: largeQuery ? 16 : 128,
  calibrationRounds: 4, measuredRounds: 16, minimumRetained: 12,
  order: 'Rotate four variants, alternate direction; reverse order for second observation',
  probes: '250000 integer operations before and after each batch; no profiling during timing',
  filter: 'Whole round rejected above 1.5x median calibration maximum probe or 250ms round wall time',
  control: 'Bootstrap 95% interval contains zero and lies inside [-5,+5] percent',
  bootstrapResamples: 10000, bootstrapSeed: 123456789,
  idle: 'Before each measured round, up to ten 20ms waits until probe <=1.2x calibration median maximum; no measured-round retries',
  gc: 'One forced GC before each whole round, outside probes and timing',
  consumption: 'Length and changing character checksum inside timing; exact preflight and equal batch checksums',
};

function prepare(URI, variant) {
  const inputs = Array.from({length:128}, (_,i) =>
    `https://example.org:8080/docs/file-${i}.html?x=a%20b&x=${i}&y=~#part-${i}`);
  const bare = inputs.map((_,i) => `https://example.org/docs/file-${i}.html`);
  const objects = inputs.map(v => URI(v));
  const references = inputs.map((_,i) => URI(`../asset-${i}.css?q=${i}#part`));
  const relativeInputs = inputs.map((_,i) => `../asset-${i}.css?q=${i}#part`);
  const nativeBases = inputs.map(value => new URL(value));
  const predicates = inputs.map((value,i) => URI(i & 1 ? value : relativeInputs[i]));
  const encoded = inputs.map((_,i) => ({'search terms': `汉字 /? !*'() ${i}`, x:['a b', 'c+d', 'e%f']}));
  const many = {x:Array.from({length:64}, (_,i) => 'value-' + (i % 32)), flag:null};
  const bareQuery = Array.from({length:512}, (_,i) => 'flag' + i).join('&') + '&tail=1';
  const longQuery = Array.from({length:24}, (_,i) => `k${i}=a%20b%2Bc-${i}`).join('&');
  const longObjects = inputs.map(() => URI('?' + longQuery));
  const encodedKeys = inputs.map(() => URI('?a+b=one&bad%ZZ=two&%E6%BC%A2%E5%AD%97=three&flag'));
  const cases = {
    'parse-absolute': i => URI(inputs[i & 127]).toString(),
    'parse-bare': i => URI(bare[i & 127]).toString(),
    'query-read': i => JSON.stringify(objects[i & 127].query(true)),
    'query-bare-read': () => JSON.stringify(URI.parseQuery(bareQuery)),
    'query-write': i => objects[i & 127].query({x:['first', 'value-' + (i & 127)], flag:'yes'}).toString(),
    'query-encoded': i => objects[i & 127].query(encoded[i & 127]).toString(),
    'query-arrays': i => objects[i & 127].query(many).toString(),
    'query-helpers': i => objects[i & 127].query('x=1&x=2&flag')
      .addQuery('x','3').setQuery('new','value-' + (i & 127)).removeQuery('x','1').toString(),
    'query-single-helper': i => objects[i & 127].query('x=1&x=2&flag').addQuery('x','3').toString(),
    'query-remove-value': i => objects[i & 127].query('x=1&x=2&x=3&flag').removeQuery('x','2').toString(),
    'query-chain-long': i => objects[i & 127].query(longQuery)
      .addQuery('k0','more').setQuery('new','value-' + (i & 127)).removeQuery('k1').toString(),
    'query-batch': i => objects[i & 127].query('x=1&x=2&flag').query(data => {
      URI.addQuery(data,'x','3');
      URI.setQuery(data,'new','value-' + (i & 127));
      URI.removeQuery(data,'x','1');
    }).toString(),
    'resolve-wrapper-base': i => references[i & 127].absoluteTo(objects[i & 127]).toString(),
    'resolve-string-base': i => references[i & 127].absoluteTo(inputs[i & 127]).toString(),
    'construct-wrapper-base': i => URI(relativeInputs[i & 127], objects[i & 127]).toString(),
    'construct-string-base': i => URI(relativeInputs[i & 127], inputs[i & 127]).toString(),
    'construct-native-base': i => URI(relativeInputs[i & 127], nativeBases[i & 127]).toString(),
    'construct-url-input': i => URI(nativeBases[i & 127], objects[i & 127]).toString(),
    'has-key': i => String(objects[i & 127].hasQuery(['x','y','missing'][i % 3])),
    'has-key-long': i => String(longObjects[i & 127].hasQuery(['k0','k12','k23','missing'][i & 3])),
    'has-key-encoded': i => String(encodedKeys[i & 127].hasQuery(['a b','bad%ZZ','漢字','missing'][i & 3])),
    'has-key-value': i => String(objects[i & 127].hasQuery('x', String(i & 127), true)),
    'is-relative': i => String(predicates[i & 127].is('relative')),
    'mutate-authority': i => objects[i & 127].protocol((i+(i>>>7))&1?'http':'https')
      .hostname(`cdn-${(i+(i>>>7))&255}.example.org`).port(8081+((i>>>7)&1)).toString(),
  };
  if (batching) return cases[variant < 2 ? 'query-helpers' : 'query-batch'];
  assert.ok(cases[selectedCase], 'Unknown case: ' + selectedCase);
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
  comparison: batching ? 'after callback batch versus after chain; URIjs uses the chain' : 'after versus before and URIjs',
  startedAt:new Date().toISOString(), preflightSha256:correctness.digest('hex'),
  hashes:{}, warmups:[], sizing:[], calibration:[], rounds:[], status:'running'};
for(const entry of [...entries, new URL(import.meta.url)]) {
  record.hashes[String(entry)] = createHash('sha256').update(await readFile(entry)).digest('hex');
}
for(const entry of [beforeEntry, afterEntry]) {
  const query = path.join(path.dirname(entry), 'uri-query.js');
  record.hashes[query] = createHash('sha256').update(await readFile(query)).digest('hex');
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
    record.urijsPercent=interval(medians.map(r => 100*(r[2]/r[0]-1)));
    record.urijsControlPercent=interval(medians.map(r => 100*(r[3]/r[0]-1)));
    record.controlPercent=interval(medians.map(r => 100*(r[3]/r[2]-1)));
    const [lo,hi]=record.controlPercent.interval95;
    record.controlPass=lo<=0 && hi>=0 && lo>=-5 && hi<=5;
    const classification=(one,two) => !record.controlPass ? 'unresolved-control' :
      one.interval95[1]<0 && two.interval95[1]<0 ? 'faster' :
        one.interval95[0]>0 && two.interval95[0]>0 ? 'slower' : 'unresolved-difference';
    record.status=classification(record.beforePercent,record.beforeControlPercent);
    record.urijsStatus=classification(record.urijsPercent,record.urijsControlPercent);
  } else record.status='unresolved-insufficient-rounds';
  record.finishedAt=new Date().toISOString();
  try { record.linuxLoadAfter=(await readFile('/proc/loadavg','utf8')).trim(); } catch { /* Windows */ }
  await save();
  console.log(JSON.stringify({case:selectedCase,status:record.status,retained:record.retained,
    before:record.beforePercent,urijs:record.urijsPercent,control:record.controlPercent,
    medianRoundMs:median(record.rounds.map(r => r.wallMs))}));
} catch(error) {
  record.status='failed';record.error=String(error);await save();throw error;
}
