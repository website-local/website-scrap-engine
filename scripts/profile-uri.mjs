// Node inspector CPU profiles with 100us sampling, or a separate V8 tick run.
// node --expose-gc scripts/profile-uri.mjs ENTRY CASE OUTPUT_PREFIX
// CASE: parse, parse-bare, read, write, helpers, authority, resolve,
// construct-wrapper, construct-string, has-key, predicate
// segment-read-short, segment-read-long
// For --prof runs, append --ticks to disable inspector sampling.
import {Session} from 'node:inspector/promises';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
const [entry, mode, output] = process.argv.slice(2);
const ticks = process.argv.includes('--ticks');
const mod = await import(pathToFileURL(entry));
const URI = mod.URI ?? mod.default;
const inputs = Array.from({length:128}, (_,i) => `https://example.org:8080/docs/file-${i}.html?x=a%20b&x=${i}&y=~#part-${i}`);
const objects = inputs.map(v => URI(v));
const segmentObjects = inputs.map((_, i) => URI('https://example.org/' +
  Array.from({length:32}, (_, n) => `part-${n}-${i}`).join('/') + '/'));
const references = inputs.map((_,i) => URI(`../asset-${i}.css?q=${i}#part`));
const relativeInputs = inputs.map((_,i) => `../asset-${i}.css?q=${i}#part`);
const predicates = inputs.map((value,i) => URI(i & 1 ? value : relativeInputs[i]));
const keyQuery = URI('?' + Array.from({length:24}, (_,i) => `k${i}=a%20b%2Bc-${i}`).join('&'));
const fns = {
  'segment-read-short': i => String(objects[i & 127].segment([0, 1, -1, -2][i & 3])),
  'segment-read-long': i => String(segmentObjects[i & 127].segment([0, 15, -1, -16][i & 3])),
  parse: i => URI(inputs[i & 127]).toString(),
  'parse-bare': i => URI(`https://example.org/docs/file-${i & 127}.html`).toString(),
  read: i => JSON.stringify(objects[i & 127].query(true)),
  write: i => objects[i & 127].query({x:['first', 'value-' + (i & 127)],flag:'yes'}).toString(),
  helpers: i => objects[i & 127].query('x=1&x=2&flag').addQuery('x','3').setQuery('new','value-' + (i & 127)).removeQuery('x','1').toString(),
  resolve: i => references[i & 127].absoluteTo(objects[i & 127]).toString(),
  'construct-wrapper': i => URI(relativeInputs[i & 127], objects[i & 127]).toString(),
  'construct-string': i => URI(relativeInputs[i & 127], inputs[i & 127]).toString(),
  'has-key': i => String(keyQuery.hasQuery(['k0','k12','k23','missing'][i & 3])),
  predicate: i => String(predicates[i & 127].is('relative')),
  authority: i => objects[i & 127].protocol((i+(i>>>7))&1?'http':'https').hostname(`cdn-${(i+(i>>>7))&255}.example.org`).port(8081+((i>>>7)&1)).toString()
};
const fn = fns[mode];
if (!fn) throw new Error('Unknown profile case');
let sink=0, cursor=0;
function batch() { for(let j=0;j<2000;j++) sink += fn(cursor++).length; }
for(let n=0;n<50;n++) batch();
global.gc();
if (ticks) {
  const started=performance.now();
  do { batch(); } while(performance.now()-started<1200);
  console.log(JSON.stringify({entry,mode,sink,kind:'V8 tick diagnostic'}));
  process.exit(0);
}
const session=new Session();session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.setSamplingInterval',{interval:100});
await session.post('Profiler.start');
const start=performance.now();
do { batch(); } while(performance.now()-start<1200);
const {profile}=await session.post('Profiler.stop');session.disconnect();
await writeFile(output+'.cpuprofile',JSON.stringify(profile));
const nodes=new Map(profile.nodes.map(n=>[n.id,n]));
const parents=new Map();for(const n of profile.nodes)for(const child of n.children??[])parents.set(child,n.id);
const self=new Map(), inclusive=new Map();
let total=0;
for(let i=0;i<profile.samples.length;i++){
  const weight=profile.timeDeltas[i]??0;total+=weight;
  const key=id=>{const f=nodes.get(id).callFrame;return `${f.functionName || '(anonymous)'} @ ${f.url}:${f.lineNumber+1}`;};
  let id=profile.samples[i];self.set(key(id),(self.get(key(id))??0)+weight);
  const seen=new Set();
  while(id!==undefined){const k=key(id);if(!seen.has(k)){inclusive.set(k,(inclusive.get(k)??0)+weight);seen.add(k);}id=parents.get(id);}
}
const sort=map=>[...map].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([frame,us])=>({frame,ms:us/1000,percent:100*us/total}));
const summary={entry,mode,node:process.version,intervalUs:100,samples:profile.samples.length,sink,self:sort(self),inclusive:sort(inclusive)};
await writeFile(output+'.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({mode,top:summary.self.slice(0,10)}));
