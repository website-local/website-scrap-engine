import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const entry = pathToFileURL(path.resolve(process.argv[2])).href;
const {downloader, resource} = await import(entry);
const {redirectHtml} = await import(new URL('life-cycle/save-html-to-disk.js', entry));
const topology = process.argv[3] || 'single';
const atomic = process.argv[4] === 'atomic';
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-html-redirect-publication-'));
const config = path.join(root, 'options.mjs');
const trace = path.join(root, 'documents.ndjson');
const content = '<html><head><title>Canonical</title></head><body><p>' + 'Canonical content '.repeat(8192) + '</p></body></html>';
const changed = content.replace(/content <\/p>/, 'content!</p>');
await fs.writeFile(config, `
import assert from 'node:assert/strict';
import {appendFileSync, promises as fs} from 'node:fs';
import path from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {threadId} from 'node:worker_threads';
import {lifeCycle, options, loadHtml} from ${JSON.stringify(entry)};
let sequence = 0;
const record = value => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({threadId, ...value}) + '\\n');
const load = (...args) => {
  const doc = loadHtml(...args), id = ++sequence;
  record({event: 'load', id});
  doc.dispose = () => record({event: 'dispose', id});
  return doc;
};
const lc = lifeCycle.defaultLifeCycle();
lc.generateSavePath.push((save, ctx) => ctx.uri.path().startsWith('/same-path/')
  ? 'example.test/same-path/final.html' : save);
lc.generateSavePath.push((save, ctx) => /\\/different-final\\/[ab]\\.html$/.test(ctx.uri.toString())
  ? 'example.test/different-final/shared.html' : save);
lc.generateSavePath.push((save, ctx) => /\\/shared-stub\\/[ab]\\.html$/.test(ctx.uri.toString())
  ? 'example.test/shared-stub/alias.html' : save);
lc.processAfterDownload.push(async res => {
  assert.ok(res.meta.doc);
  if (res.meta.inferredPath) res.redirectedSavePath = undefined;
  if (res.meta.waitFor) {
    const deadline = Date.now() + 5000;
    while (true) {
      try { await fs.access(path.join(res.localRoot, res.meta.waitFor)); break; }
      catch { if (Date.now() > deadline) throw new Error('Canonical publication did not finish'); }
      await setTimeout(5);
    }
  }
  return res;
});
export default options.defaultDownloadOptions({...lc, initialUrl: [],
  localRoot: ${JSON.stringify(root)}, concurrency: 2, workerCount: 2, maxDepth: 0,
  atomicWrites: ${atomic}, loadHtml: load,
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
const Crawler = topology === 'worker' ? downloader.MultiThreadDownloader : downloader.SingleThreadDownloader;
const crawler = new Crawler(pathToFileURL(config).href);
const checks = [];
const local = suffix => path.join(root, 'example.test', suffix);
const make = async (suffix, redirected, body = content, meta = {}) => {
  const url = 'https://example.test/' + suffix;
  const res = await crawler.pipeline.createResource(resource.ResourceType.Html, 0, url, url);
  assert.ok(res);
  res.body = body;
  Object.assign(res.meta, meta);
  if (redirected) res.redirectedUrl = 'https://example.test/' + redirected;
  return res;
};
const run = async (...resources) => {
  crawler.stop();
  for (const res of resources) assert.equal(crawler.addProcessedResource(res), true, res.url);
  await crawler.start();
  await crawler.onIdle();
  for (const res of resources) {
    assert.equal(res.meta.doc, undefined);
    if (res.meta.error) {
      const {name, message, code, stack} = res.meta.error;
      await fs.appendFile(path.join(root, 'failures.ndjson'), JSON.stringify({url: res.url,
        outcome: crawler.outcomes.get(res.url), error: {name, message, code, stack}}) + '\n');
    }
  }
  return resources.map(res => crawler.outcomes.get(res.url));
};
const saved = outcomes => outcomes.forEach(outcome => assert.equal(outcome.status, 'saved', JSON.stringify(outcome)));
const canonical = async suffix => assert.equal(await fs.readFile(local(suffix), 'utf8'), content, suffix);
const stub = async (suffix, relative) => {
  assert.equal(await fs.readFile(local(suffix), 'utf8'), redirectHtml(relative, 'utf8'), suffix);
  await canonical(path.posix.join(path.posix.dirname(suffix), relative));
};
const conflict = (outcome, res) => {
  assert.equal(outcome.status, 'failed');
  assert.equal(res.meta.error.code, 'ERR_OUTPUT_CONFLICT');
};
let succeeded = false;
try {
  await crawler.init;
  for (const inferredPath of [false, true]) {
    const prefix = inferredPath ? 'inferred' : 'explicit';
    saved(await run(await make(prefix + '/final.html')));
    const aliasPath = prefix + (inferredPath ? '/alias.html' : '/final/Reference.html');
    const alias = await make(aliasPath, prefix + '/final.html', content, {inferredPath});
    const [outcome] = await run(alias);
    saved([outcome]);
    assert.equal(outcome.publishedFiles, 2);
    await stub(aliasPath, inferredPath ? 'final.html' : '../final.html');
  }
  checks.push('canonical first, with explicit and inferred redirect paths, retains exact linked alias HTML');

  saved(await run(await make('concurrent/left.html', 'concurrent/final.html'),
    await make('concurrent/right.html', 'concurrent/final.html')));
  await stub('concurrent/left.html', 'final.html');
  await stub('concurrent/right.html', 'final.html');
  checks.push('concurrent aliases retain two stubs and one canonical page');

  const alias = await make('alias-first/alias.html', 'alias-first/final.html');
  const direct = await make('alias-first/final.html', undefined, content,
    {waitFor: 'example.test/alias-first/final.html'});
  saved(await run(alias, direct));
  await stub('alias-first/alias.html', 'final.html');
  checks.push('already admitted canonical page may complete after its alias');

  const sameAlias = await make('same-path/alias.html', 'same-path/final.html');
  const sameDirect = await make('same-path/final.html', undefined, content,
    {waitFor: 'example.test/same-path/final.html'});
  const sameOutcomes = await run(sameAlias, sameDirect);
  saved(sameOutcomes);
  assert.ok(sameOutcomes.every(outcome => outcome.publishedFiles === 1));
  await canonical('same-path/final.html');
  checks.push('coincident save paths preserve the canonical body without a self-redirect');

  saved(await run(await make('different-content/final.html')));
  const wrongBytes = await make('different-content/alias.html', 'different-content/final.html', changed);
  conflict((await run(wrongBytes))[0], wrongBytes);
  await canonical('different-content/final.html');
  checks.push('different canonical bytes still conflict and cannot replace the published page');

  saved(await run(await make('different-source/left.html', 'different-final/a.html')));
  const wrongIdentity = await make('different-source/right.html', 'different-final/b.html');
  conflict((await run(wrongIdentity))[0], wrongIdentity);
  await canonical('different-final/shared.html');
  checks.push('distinct final URLs sharing a custom destination still conflict');

  saved(await run(await make('shared-stub/a.html', 'shared-stub/final.html')));
  const sharedStub = await make('shared-stub/b.html', 'shared-stub/final.html');
  conflict((await run(sharedStub))[0], sharedStub);
  await stub('shared-stub/alias.html', 'final.html');
  checks.push('redirect stubs remain exclusively owned even with identical final URL and bytes');

  const all = await fs.readdir(root, {recursive: true});
  assert.ok(all.every(name => !name.includes('.wse-stage-')));
  assert.ok(Object.values(crawler.outputReservations).every(value => value.active === 0 && !value.waiters?.size));
  const records = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const documents = new Map();
  for (const {threadId, id, event} of records) {
    const key = threadId + ':' + id;
    assert.equal(documents.get(key), event === 'load' ? undefined : 'load');
    documents.set(key, event);
  }
  assert.equal(documents.size, crawler.outcomes.size);
  assert.ok([...documents.values()].every(event => event === 'dispose'));
  succeeded = true;
  console.log(JSON.stringify({topology, atomic, checks, outcomes: crawler.outcomes.size, documents: documents.size}));
} finally {
  await crawler.dispose();
  if (succeeded) await fs.rm(root, {recursive: true, force: true});
  else console.error('Retained failed HTML redirect outputs: ' + root);
}
