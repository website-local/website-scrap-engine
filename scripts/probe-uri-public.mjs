// Public API differential audit; URIjs internal state is deliberately excluded.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const [legacyEntry, beforeEntry, afterEntry, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: node scripts/probe-uri-public.mjs URIJS BEFORE AFTER OUTPUT');
const apis = await Promise.all([legacyEntry, beforeEntry, afterEntry].map(async entry =>
  (await import(pathToFileURL(entry))).default));
const functions = api => Object.getOwnPropertyNames(api).filter(k => typeof api[k] === 'function' && k !== 'constructor' && !k.startsWith('_')).sort();
const inventory = apis.map(api => ({static: functions(api), instance: functions(api.prototype)}));
const stats = {}, examples = {};
const capture = fn => { try { return {value: fn()}; } catch (e) { return {error: e.name}; } };
function check(group, input, operation) {
  const results = apis.map(api => capture(() => operation(api)));
  const strings = results.map(value => JSON.stringify(value));
  const row = stats[group] ??= {checks: 0, beforeDifferences: 0, afterDifferences: 0, newlyDifferent: 0, changedSinceBefore: 0};
  row.checks++;
  if (strings[1] !== strings[2]) row.changedSinceBefore++;
  if (strings[0] !== strings[1]) row.beforeDifferences++;
  if (strings[0] !== strings[2]) row.afterDifferences++;
  if (strings[0] === strings[1] && strings[0] !== strings[2]) row.newlyDifferent++;
  if (strings[0] !== strings[2] || strings[0] !== strings[1]) {
    const list = examples[group] ??= [];
    if (list.length < 6) list.push({input, results});
  }
}
const atoms = ['', 'abc', 'a b', '/', ':', '?', '#', '@', '[x]', '%2F', '%3A', '%25', '%ZZ', '%FF', 'é', '漢字', '\\', '\\@', '%5C', '!()*', '+&=', '\ud800'];
const texts = [...atoms, ...atoms.flatMap(a => atoms.map(b => a + '/' + b))];
const codecs = ['encode', 'decode', 'encodeReserved', 'encodePathSegment', 'decodePathSegment',
  'encodeUrnPathSegment', 'decodeUrnPathSegment', 'decodePath', 'decodeUrnPath', 'recodePath', 'recodeUrnPath'];
for (const method of codecs) for (const value of texts) check(method, value, api => api[method](value));
for (const username of atoms) for (const password of atoms) {
  const parts = {protocol:'https', hostname:'example.org', port:'8080', username, password, path:'/a', query:'x=1', fragment:'h'};
  for (const method of ['buildUserinfo', 'buildAuthority', 'build']) check(method, parts, api => api[method](parts));
  check('parts-constructor', parts, api => api(parts).href());
}
for (const hostname of ['', 'example.org', '[::1]', '::1']) for (const port of ['', '80', '8080'])
  check('buildHost', {hostname,port}, api => api.buildHost({hostname,port}));
for (const a of ['', 'a', '/', '/a/', '/a/b', '../x', 'a:b']) for (const b of ['', '/', 'b', '../c']) {
  check('joinPaths', [a,b], api => api.joinPaths(a,b).href());
  check('commonPath', [a,b], api => api.commonPath(a,b));
}
for (const value of texts) {
  const input = value + ':p%3Ass@example.org/a';
  check('parseUserinfo', input, api => { const parts={}; return [api.parseUserinfo(input,parts),parts.username,parts.password]; });
}
for (const name of atoms) for (const value of [null,undefined,false,0,'a b','%20']) for (const spaces of [true,false])
  check('buildQueryParameter', [name,value,spaces], api => api.buildQueryParameter(name,value,spaces));
for (const input of ['https://u%20s:p%3Ass@example.org/a?x=1#h', 'https://example.org/', '../a?x=1', 'urn:a:b']) {
  check('parse-build', input, api => api.build(api.parse(input)));
  for (const method of ['username','password','userinfo','authority','origin','protocol','hostname','port','path','directory','filename','suffix','segment','segmentCoded','query','fragment'])
    check('get:'+method,input,api=>api(input)[method]());
}
for (const replacement of [undefined,'x','https://longer.example/path','']) {
  const source='See https://a.example/a then https://b.example/b done';
  check('withinString', String(replacement), api => { const calls=[];const result=api.withinString(source,(...args)=>{calls.push(args);return replacement;});return {result,calls}; });
}
for (const method of ['absoluteTo','relativeTo']) for (const duplicates of [false,true]) for (const spaces of [false,true]) {
  for (const input of ['../b','https://example.org/a','https://example.org/a?new=1','https://example.org/a#h','https://other.org/b']) {
    check('policy:'+method, {input,duplicates,spaces}, api => {
      const source=api(input).duplicateQueryParameters(duplicates).escapeQuerySpace(spaces);
      const result=source[method]('https://example.org/a');
      return {query:result.query({x:['a b','a b']}).query(),source:source.href()};
    });
  }
}
const result={entries:[legacyEntry,beforeEntry,afterEntry],inventory,stats,examples,
  scope:'Selected public operations and string inputs; not a global compatibility percentage. No private/internal assertions.'};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({checks:Object.values(stats).reduce((n,s)=>n+s.checks,0),stats,missingStatic:inventory[0].static.filter(k=>!inventory[2].static.includes(k)),missingInstance:inventory[0].instance.filter(k=>!inventory[2].instance.includes(k))},null,2));
