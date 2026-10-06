import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Bounded adversarial witnesses. Each family gets a separate five-second-capped
// subprocess. Run BEFORE_LIB AFTER_LIB OUTPUT; no full crawl or network input.
const [beforeDir, afterDir, output, family] = process.argv.slice(2);
const sizes = {comments:[1024,2048,4096], css:[128,256,512], refresh:[128,256,512],
  schemes:[1024,2048,4096], segments:[1024,2048,4096]};
// Baseline adapter for builds predating the separately exported extractor.
function legacyRefresh(value) {
  const match = /^\s*(\d+)(?:\s*;(?:\s*url\s*=)?\s*(?:["']\s*(.*?)\s*['"]|(.*?)))?\s*$/i.exec(value);
  return match?.[2] || match?.[3] || undefined;
}
async function load(dir) {
  const [uri, css, meta] = await Promise.all(['uri.js','life-cycle/parse-css-urls.js',
    'life-cycle/process-html-meta.js'].map(file => import(pathToFileURL(resolve(dir,file)))));
  return {URI:uri.default, css:css.parseCssUrlMatches, refresh:meta.parseRefreshLink ?? legacyRefresh};
}
function operation(api, n) {
  switch(family) {
    case 'comments': {const s='/*a'.repeat(n);return () => api.css(s);}
    case 'css': {const s='url('+' '.repeat(n)+'x';return () => api.css(s);}
    case 'refresh': {const s='0;'+' '.repeat(n)+'x\n!';return () => api.refresh(s);}
    case 'schemes': {const s='a-'.repeat(n)+'!';return () => api.URI.withinString(s, () => {});}
    case 'segments': {const s='a'+'/'.repeat(n)+'b';return () => api.URI('/base/').segment(s).path();}
  }
}
if (family) {
  const apis=await Promise.all([beforeDir,afterDir].map(load)), rows=[];
  for(const n of sizes[family]) {
    const work=apis.map(api => operation(api,n));
    const expected=work[0]();
    assert.deepEqual(expected,work[1]());
    const observations=[];
    for(let pair=0;pair<4;pair++) for(const variant of pair%2 ? [1,0] : [0,1]) {
      const cpu=process.cpuUsage(), start=performance.now();
      const result=work[variant]();
      const ms=performance.now()-start, used=process.cpuUsage(cpu);
      observations.push({pair,variant,ms,cpuMs:(used.user+used.system)/1000});
      assert.deepEqual(result,expected);
    }
    rows.push({n,observations});
  }
  // Exercise the fixed implementation at a larger size without running the
  // vulnerable baseline at that size.
  const large=operation(apis[1],32768), start=performance.now();large();
  console.log(JSON.stringify({rows,candidateLarge:{n:32768,ms:performance.now()-start}}));
} else {
  assert.ok(output, 'Provide BEFORE_LIB AFTER_LIB OUTPUT');
  const result={runtime:process.version,method:'Four alternating before/after pairs; five-second process cap per family; diagnostic timings, no host-noise gate',hashes:{},cases:{}};
  for(const dir of [beforeDir,afterDir]) for(const file of ['uri.js','life-cycle/parse-css-urls.js','life-cycle/process-html-meta.js']) {
    const path=resolve(dir,file);result.hashes[path]=createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  for(const name of Object.keys(sizes)) {
    const child=spawnSync(process.execPath,[process.argv[1],beforeDir,afterDir,output,name],{encoding:'utf8',timeout:5000});
    result.cases[name]=child.status===0 ? JSON.parse(child.stdout) : {failed:true,timeout:child.error?.code==='ETIMEDOUT',stderr:child.stderr};
  }
  writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result.cases));
}
