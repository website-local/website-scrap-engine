// Offline output-contract replay, without fetching bodies or starting a crawler.
// node scripts/probe-mdn-output.mjs BEFORE_ENGINE BEFORE_MDN AFTER_ENGINE AFTER_MDN INPUT OUTPUT
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {load} from 'cheerio';

net.Socket.prototype.connect = function () { throw new Error('Network disabled in output replay'); };
const [beforeEngine, beforeMdn, afterEngine, afterMdn, inputFile, outputFile] = process.argv.slice(2);
const publish = process.argv.includes('--publish');
if (!outputFile) throw new Error('Provide two engine/lifecycle pairs, input JSON and output JSON');
const inputs = JSON.parse(fs.readFileSync(inputFile));
const variants = [];
const silent = {trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled() { return false; }};
for (const [entry, lifecycle] of [[beforeEngine, beforeMdn], [afterEngine, afterMdn]]) {
  const api = await import(pathToFileURL(path.resolve(entry)));
  api.logger.setLogger(silent);
  const {default: base} = await import(pathToFileURL(path.resolve(lifecycle)));
  variants.push({id: variants.length, api, base, contexts: new Map(), groups: new Map(), files: new Map(),
    counts: {}, examples: {}, hash: createHash('sha256')});
}
const differences = {}, examples = {}, transitions = [new Map(), new Map()], changedIndexes = [];
const bump = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
function example(target, key, row) {
  const list = target[key] ??= [];
  if (list.length < 12) list.push(row);
}
function recordIssue(v, key, row) { bump(v.counts, key); example(v.examples, key, row); }
const normalizeDisk = value => path.resolve('/', decodeURI(value));
function context(v, row) {
  const locale = row.archive?.includes('zh-CN') ? 'zh-CN' : 'en-US';
  if (!v.contexts.has(locale)) {
    const options = {...v.base, meta: {...v.base.meta, locale},
      localRoot: path.resolve(path.dirname(outputFile), 'virtual-output', locale)};
    const pipeline = new v.api.downloader.PipelineExecutorImpl(options, options.req, options);
    v.contexts.set(locale, {options, pipeline, parents: new Map()});
  }
  return v.contexts.get(locale);
}
async function replay(v, row, index) {
  const {options, pipeline, parents} = context(v, row);
  // Corpus extraction did not retain DOM tags. Exercise hrefs as anchors and
  // asset references as images; log tokens are hypothetical anchor inputs.
  const isAsset = ['src', 'srcset', 'css-url', 'xlink:href'].includes(row.kind);
  const parentType = row.member?.endsWith('.svg') ? 6 : row.member?.endsWith('.css') ? 3 : 2;
  const attribute = isAsset ? 'src' : 'href';
  const element = load(isAsset ? '<img>' : '<a></a>')(isAsset ? 'img' : 'a');
  element.attr(attribute, row.input);
  let res;
  try {
    let parent = parents.get(row.base);
    if (!parent) {
      parent = await pipeline.createResource(parentType, 0, row.base, row.base, options.localRoot);
      if (!parent) return {status: 'parent-skipped'};
      if (parents.size > 2048) parents.clear();
      parents.set(row.base, parent);
    }
    res = await pipeline.createAndProcessResource(row.input,
      row.kind === 'document' ? parentType : isAsset ? 1 : 2, 1,
      row.kind === 'document' ? null : element, parent);
    if (!res) return {status: 'skipped', replacement: element.attr(attribute)};
    const key = v.api.downloader.AbstractDownloader.prototype.canonicalUrl.call({options}, res.url, res.uri);
    const result = {status: res.shouldBeDiscardedFromDownload ? 'discarded' : 'accepted',
      url: res.url, downloadLink: res.downloadLink, savePath: res.savePath,
      refSavePath: res.refSavePath, replacement: res.replacePath, key, type: res.type};
    try {
      result.diskPath = normalizeDisk(res.savePath);
      const parentDisk = normalizeDisk(res.refSavePath);
      const destination = new URL(res.replacePath, pathToFileURL(parentDisk));
      result.destination = destination.protocol === 'file:' ? fileURLToPath(destination) : destination.href;
      try { result.fragment = decodeURIComponent(destination.hash.slice(1)); }
      catch { result.fragment = destination.hash.slice(1); }
      result.search = destination.search;
      result.local = destination.protocol === 'file:';
      result.linkMatchesFile = result.local && result.destination === result.diskPath;
    } catch (error) { result.pathError = error.name; }
    if (publish && result.status === 'accepted' && result.local && !result.pathError) {
      const localRoot = path.resolve(path.dirname(outputFile), 'published', String(index), String(v.id));
      const marker = 'offline-output-marker-' + index;
      const parent = await pipeline.createResource(2, 0, row.base, row.base, localRoot);
      parent.savePath = res.refSavePath;
      parent.localRoot = localRoot;
      const document = load('<!doctype html><html><body><a id="probe"></a></body></html>');
      document('#probe').attr('href', res.replacePath).text(marker);
      parent.body = document.html();
      parent.encoding = 'utf8';
      res.localRoot = localRoot;
      res.body = marker;
      res.encoding = 'utf8';
      await v.api.lifeCycle.saveHtmlToDisk(parent, options, pipeline);
      if (normalizeDisk(res.savePath) !== normalizeDisk(parent.savePath)) {
        await (res.type === 2 ? v.api.lifeCycle.saveHtmlToDisk : v.api.lifeCycle.saveResourceToDisk)(res, options, pipeline);
      }
      const parentFile = path.resolve(localRoot, decodeURI(parent.savePath));
      const emitted = load(fs.readFileSync(parentFile, 'utf8'))('#probe').attr('href');
      const target = fileURLToPath(new URL(emitted, pathToFileURL(parentFile)));
      result.publishedLinkWorks = fs.readFileSync(target, 'utf8').includes(marker);
      if (!result.publishedLinkWorks) throw new Error('Written link did not reach expected fixture body');
    }
    return result;
  } catch (error) { return {status: 'error', error: error.name, message: error.message}; }
}
function account(v, result, row, index) {
  bump(v.counts, result.status);
  if (result.status === 'error') example(v.examples, 'errors', {index, ...row, result});
  if (result.publishedLinkWorks) bump(v.counts, 'publishedLinksVerified');
  v.hash.update(JSON.stringify(result)).update('\n');
  if (result.status !== 'accepted') return;
  const sample = {index, ...row, result};
  if (result.pathError) recordIssue(v, 'pathErrors', sample);
  else if (result.local && !result.linkMatchesFile) recordIssue(v, 'linkTargetMismatch', sample);
  else if (!result.local) recordIssue(v, 'acceptedExternalReplacement', sample);
  const scope = (row.archive ?? '') + '\0';
  const key = scope + result.key;
  const old = v.groups.get(key);
  if (old) {
    if (old.diskPath !== result.diskPath) recordIssue(v, 'dedupDifferentFiles', {first: old, ...sample});
    if (old.downloadLink !== result.downloadLink) recordIssue(v, 'dedupDifferentRequests', {first: old, ...sample});
  } else v.groups.set(key, {index, diskPath: result.diskPath, downloadLink: result.downloadLink});
  if (result.diskPath) {
    // Fold case separately to expose Windows output conflicts as well.
    for (const fold of [false, true]) {
      const file = scope + (fold ? 'fold:' + result.diskPath.toLowerCase() : result.diskPath);
      const previous = v.files.get(file);
      if (previous && previous.key !== result.key) {
        recordIssue(v, fold ? 'caseFoldFileCollisions' : 'fileCollisions', {first: previous, ...sample});
      } else if (!previous) v.files.set(file, {index, key: result.key, diskPath: result.diskPath});
    }
  }
}
for (let index = 0; index < inputs.length; index++) {
  const row = inputs[index];
  const results = [];
  for (const v of variants) {
    const result = await replay(v, row, index);
    results.push(result);
    account(v, result, row, index);
  }
  const [before, after] = results;
  let changed = false;
  for (const field of ['status', 'error', 'diskPath', 'destination', 'fragment', 'search', 'replacement', 'key', 'downloadLink', 'type']) {
    if (before[field] !== after[field]) {
      changed = true;
      bump(differences, field);
      example(examples, field, {index, ...row, before, after});
    }
  }
  if (changed) changedIndexes.push(index);
  if (after.status === 'accepted' && after.local && !after.linkMatchesFile &&
      !(before.status === 'accepted' && before.local && !before.linkMatchesFile)) {
    bump(differences, 'newLinkTargetMismatch');
    example(examples, 'newLinkTargetMismatch', {index, ...row, before, after});
  }
  if (before.status === 'accepted' && after.status === 'accepted') {
    const scope = (row.archive ?? '') + '\0';
    for (let side = 0; side < 2; side++) {
      const from = scope + results[side].key, to = results[1 - side].key;
      const old = transitions[side].get(from);
      if (old !== undefined && old !== to) {
        const kind = side ? 'mergedDedupGroups' : 'splitDedupGroups';
        bump(differences, kind);
        example(examples, kind, {index, ...row, previousOtherKey: old, before, after});
      } else if (old === undefined) transitions[side].set(from, to);
    }
  }
  if ((index + 1) % 10000 === 0) console.error(JSON.stringify({processed: index + 1, total: inputs.length}));
}
const report = {
  scope: 'Offline MDN output contract, actual pre-download hooks and disk-name decoding; no body acquisition or after-download redirect processing',
  publication: publish ? 'Real HTML/binary writers with minimal fixture bodies and read-back of emitted links' : 'Virtual output graph; no publication',
  assumptions: ['href/log inputs modeled as anchors; asset inputs modeled as images; original DOM attributes unavailable',
    'Archive-scoped dedup groups, archive locale; corpus order is not crawl scheduling',
    'Accepted targets assumed acquired successfully; missing unsampled bodies are not counted as broken links',
    'Collision counts are observations against first group member, not unique lost files',
    'Case-fold collisions are candidates, not a full Windows filesystem model'],
  entries: [beforeEngine, beforeMdn, afterEngine, afterMdn], inputFile,
  inputSha256: createHash('sha256').update(fs.readFileSync(inputFile)).digest('hex'),
  node: process.version, cases: inputs.length, differences, examples, changedIndexes,
  variants: variants.map(v => ({counts: v.counts, examples: v.examples,
    dedupGroups: v.groups.size, outputFingerprint: v.hash.digest('hex')})),
};
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({cases: report.cases, differences, variants: report.variants.map(v => ({counts: v.counts, dedupGroups: v.dedupGroups}))}, null, 2));
