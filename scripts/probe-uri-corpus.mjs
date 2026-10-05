// Differential probe for extracted {input, base, ...provenance} records.
// Native constructor/resolution contracts are checked separately from URIjs APIs.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const [legacyEntry,entry,inputFile,out]=process.argv.slice(2);
if (!out) throw new Error('Usage: node scripts/probe-uri-corpus.mjs URIJS_ENTRY WRAPPER_ENTRY INPUT_JSON OUTPUT_JSON');
const {default:URI}=await import(pathToFileURL(entry));
const {default:Legacy}=await import(pathToFileURL(legacyEntry));
const rows=JSON.parse(fs.readFileSync(inputFile));
const stats={},examples={};let checked=0,rejectedNative=0;const seen=new Set();
function capture(fn){try{return {value:fn()};}catch(e){return {error:e.name};}}
function compare(key,expected,actual,row){const s=stats[key]??={checks:0,failures:0};s.checks++;checked++;if(JSON.stringify(expected)!==JSON.stringify(actual)){s.failures++;const a=examples[key]??=[];if(a.length<40&&!a.some(x=>x.input===row.input))a.push({...row,expected,actual});}}
const operations={
 href:u=>u.href(),path:u=>u.path(),decodedPath:u=>u.path(true),filename:u=>u.filename(),decodedFilename:u=>u.filename(true),directory:u=>u.directory(),decodedDirectory:u=>u.directory(true),suffix:u=>u.suffix(),segment:u=>u.segment(),segmentCoded:u=>u.segmentCoded(),query:u=>u.query(true),readable:u=>u.readable(),normalize:u=>u.normalize().href(),normalizePath:u=>u.normalizePath().href(),normalizeQuery:u=>u.normalizeQuery().href(),normalizeFragment:u=>u.normalizeFragment().href(),
 'query-chain':u=>u.addQuery('probe',['a b','x+y']).setQuery('probeFlag',null).removeQuery('probe','x+y').href(),
 'filename-set':u=>u.filename('probe.txt').href(),'directory-set':u=>u.directory('/probe/').href(),'suffix-set':u=>u.suffix('json').href(),
 'segment-set':u=>u.segment(-1,'probe').href(),'segmentCoded-set':u=>u.segmentCoded(-1,'漢字 /?#').href(),
 'hash-clear':u=>u.hash('').href(), 'query-clear':u=>u.query('').href(),
 predicates:u=>['relative','absolute','url','urn'].map(x=>u.is(x)),
};
let processed=0;
for(const row of rows){
 if(++processed%25000===0)console.log(JSON.stringify({processed,total:rows.length}));
 const {input,base}=row;

 if(!seen.has(input)){
  seen.add(input);
  compare('raw-parse',capture(()=>Legacy(input).href()),capture(()=>URI(input).href()),row);
  for(const name of ['normalize','normalizePath','readable','decodedPath','segment','segmentCoded'])compare('raw-'+name,capture(()=>operations[name](Legacy(input))),capture(()=>operations[name](URI(input))),row);
 }
 let canonical;try{canonical=new URL(input,base).href;}catch{rejectedNative++;compare('native-rejection',{error:'TypeError'},capture(()=>URI(input).absoluteTo(base).href()),row);compare('raw-resolution',{error:'TypeError'},capture(()=>URI(input,base).href()),row);continue;}
 compare('raw-resolution',{value:canonical},capture(()=>URI(input,base).href()),row);
 compare('native-resolution',{value:canonical},capture(()=>URI(input).absoluteTo(base).href()),row);
 if(seen.has('resolved:'+canonical))continue;seen.add('resolved:'+canonical);
 const sample={...row,canonical};
 for(const [name,fn] of Object.entries(operations))compare(name,capture(()=>fn(Legacy(canonical))),capture(()=>fn(URI(canonical))),sample);
 const relative=capture(()=>URI(canonical).relativeTo(base).href());
 compare('relative-roundtrip',{value:canonical},capture(()=>new URL(relative.value,base).href),sample);
}
fs.writeFileSync(out,JSON.stringify({entry,checked,rejectedNative,stats,examples},null,2));
console.log(JSON.stringify({checked,rejectedNative,failures:Object.fromEntries(Object.entries(stats).filter(([,s])=>s.failures))},null,2));
