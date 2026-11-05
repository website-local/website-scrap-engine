import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const entry = pathToFileURL(path.resolve(process.argv[2])).href;
const {downloader, resource} = await import(entry);
const topology = process.argv[3] || 'single';
const atomic = process.argv[4] === 'atomic';
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-redirect-publication-'));
const config = path.join(root, 'options.mjs');
const content = Buffer.alloc(131097, 0x5a);
content[0] = 0;
content[65536] = 255;
content[content.length - 1] = 0x80;
const changed = Buffer.from(content);
changed[changed.length - 1] = 0x81;
await fs.writeFile(config, `
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {lifeCycle, options} from ${JSON.stringify(entry)};
import {publishFile} from ${JSON.stringify(new URL('./output-store.js', entry).href)};
const lc = lifeCycle.defaultLifeCycle();
lc.generateSavePath.push((save, ctx) => ctx.uri.path().startsWith('/same-path/')
  ? 'example.test/same-path/final.bin' : save);
lc.generateSavePath.push((save, ctx) => /\\/different-final\\/[ab]\\.bin$/.test(ctx.uri.toString())
  ? 'example.test/different-final/shared.bin' : save);
lc.processAfterDownload.push(async res => {
  if (res.meta.waitForAlias) {
    const deadline = Date.now() + 5000;
    while (true) {
      try { await fs.access(path.join(res.localRoot, res.meta.waitForAlias)); break; }
      catch { if (Date.now() > deadline) throw new Error('Alias publication did not finish'); }
      await setTimeout(5);
    }
  }
  return res;
});
lc.saveToDisk.unshift(async (res, opt, pipeline) => {
  if (res.url.includes('/custom/')) {
    await publishFile(path.join(res.localRoot, 'custom.bin'), p => fs.writeFile(p, res.body),
      pipeline.signal, res.localRoot, undefined, false, res, pipeline.publicationStore);
    return;
  }
  if (res.url.endsWith('/retry.bin')) {
    await lifeCycle.saveResourceToDisk(res, opt, pipeline);
    if (res.meta.failAfterSave) throw new Error('Later hook failed');
    return;
  }
  return res;
});
export default options.defaultDownloadOptions({...lc, initialUrl: [],
  localRoot: ${JSON.stringify(root)}, concurrency: 2, workerCount: 2,
  atomicWrites: ${atomic},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
const Crawler = topology === 'worker' ? downloader.MultiThreadDownloader : downloader.SingleThreadDownloader;
const crawler = new Crawler(pathToFileURL(config).href);
const checks = [];
const local = suffix => path.join(root, 'example.test', suffix);
const make = async (suffix, redirected, bytes = content, meta = {}) => {
  const url = 'https://example.test/' + suffix;
  const res = await crawler.pipeline.createResource(resource.ResourceType.Binary, 0, url, url);
  assert.ok(res);
  res.body = Buffer.from(bytes);
  Object.assign(res.meta, meta);
  if (redirected) res.redirectedUrl = 'https://example.test/' + redirected;
  return res;
};
const run = async (...resources) => {
  crawler.stop();
  for (const res of resources) assert.equal(crawler.addProcessedResource(res), true, res.url);
  await crawler.start();
  await crawler.onIdle();
  return resources.map(res => crawler.outcomes.get(res.url));
};
const saved = outcomes => outcomes.forEach(outcome => assert.equal(outcome.status, 'saved', JSON.stringify(outcome)));
const equal = async suffix => assert.deepEqual(await fs.readFile(local(suffix)), content, suffix);
const conflict = (outcome, res) => {
  assert.equal(outcome.status, 'failed');
  assert.equal(res.meta.error.code, 'ERR_OUTPUT_CONFLICT');
};
try {
  await crawler.init;
  saved(await run(await make('concurrent/left.bin', 'concurrent/final.bin'),
    await make('concurrent/right.bin', 'concurrent/final.bin')));
  for (const name of ['left', 'right', 'final']) await equal('concurrent/' + name + '.bin');
  checks.push('concurrent aliases preserve both originals and one canonical body');

  saved(await run(await make('direct-first/final.bin')));
  saved(await run(await make('direct-first/alias.bin', 'direct-first/final.bin')));
  await equal('direct-first/final.bin');
  await equal('direct-first/alias.bin');
  checks.push('direct canonical publication before alias');

  const alias = await make('alias-first/alias.bin', 'alias-first/final.bin');
  const direct = await make('alias-first/final.bin', undefined, content,
    {waitForAlias: 'example.test/alias-first/alias.bin'});
  saved(await run(alias, direct));
  await equal('alias-first/alias.bin');
  await equal('alias-first/final.bin');
  checks.push('admitted direct canonical publication waits until alias has saved');

  const samePathAlias = await make('same-path/alias.bin', 'same-path/final.bin');
  const samePathDirect = await make('same-path/final.bin', undefined, content,
    {waitForAlias: 'example.test/same-path/final.bin'});
  const samePathOutcomes = await run(samePathAlias, samePathDirect);
  saved(samePathOutcomes);
  assert.ok(samePathOutcomes.every(outcome => outcome.publishedFiles === 1));
  await equal('same-path/final.bin');
  checks.push('equal original and redirected save paths use final content identity');

  saved(await run(await make('different-content/left.bin', 'different-content/final.bin')));
  const wrongBytes = await make('different-content/right.bin', 'different-content/final.bin', changed);
  conflict((await run(wrongBytes))[0], wrongBytes);
  await equal('different-content/final.bin');
  await assert.rejects(fs.access(local('different-content/right.bin')));
  checks.push('same final URL with different last byte fails without replacing canonical bytes');

  saved(await run(await make('different-source/left.bin', 'different-final/a.bin')));
  await equal('different-final/shared.bin');
  const wrongIdentity = await make('different-source/right.bin', 'different-final/b.bin');
  conflict((await run(wrongIdentity))[0], wrongIdentity);
  await equal('different-final/shared.bin');
  checks.push('different final URLs sharing a custom destination still conflict');

  saved(await run(await make('custom/one.bin')));
  const custom = await make('custom/two.bin');
  conflict((await run(custom))[0], custom);
  assert.deepEqual(await fs.readFile(path.join(root, 'custom.bin')), content);
  checks.push('arbitrary custom publishers cannot share identical bytes across owners');

  const partial = await make('retry.bin', undefined, content, {failAfterSave: true});
  assert.equal((await run(partial))[0].status, 'failed');
  const retry = await make('retry.bin', undefined, changed);
  const retried = (await run(retry))[0];
  saved([retried]);
  assert.equal(retried.attempt, 2);
  assert.deepEqual(await fs.readFile(local('retry.bin')), changed);
  checks.push('unshared owner retry may replace its previously published bytes');

  const all = await fs.readdir(root, {recursive: true});
  assert.ok(all.every(name => !name.includes('.wse-stage-')), 'staging allocations must be removed');
  assert.ok(Object.values(crawler.outputReservations).every(value => value.active === 0));
  console.log(JSON.stringify({topology, atomic, checks, outcomes: crawler.outcomes.size}));
} finally {
  await crawler.dispose();
  await fs.rm(root, {recursive: true, force: true});
}
