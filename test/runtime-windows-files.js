import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

assert.equal(process.platform, 'win32', 'Run this check with native Windows Node');
const entry = pathToFileURL(path.resolve(process.argv[2]));
const {downloader, resource, io} = await import(entry.href);
const {publishFile, createFilePublication} = await import(new URL('output-store.js', entry));
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-windows-'));
const checks = [];
const limitations = [];
try {
  for (const directWrites of [true, false]) {
    const output = path.join(root, directWrites ? 'direct' : 'atomic');
    const outside = path.join(root, 'outside-' + directWrites);
    await fs.mkdir(output);
    await fs.mkdir(outside);
    const config = path.join(root, 'publication-' + directWrites + '.mjs');
    await fs.writeFile(config, `
import {lifeCycle, options} from ${JSON.stringify(entry.href)};
export default options.defaultDownloadOptions({...lifeCycle.defaultLifeCycle(),
  localRoot: ${JSON.stringify(output)}, initialUrl: [], atomicWrites: ${!directWrites}, strictOutputChecks: true,
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
    const crawler = new downloader.SingleThreadDownloader(pathToFileURL(config).href);
    try {
      await crawler.init;
      const res = resource.createResource({type: resource.ResourceType.Binary, depth: 0,
        url: 'https://example.test/one', refUrl: 'https://example.test/', localRoot: output});
      const destination = path.join(output, 'asset');
      await fs.writeFile(destination, 'cached');
      await assert.rejects(publishFile(destination, async target => {
        await fs.writeFile(target, 'partial');
        throw new Error('writer failed');
      }, crawler.signal, output, undefined, false, res, crawler), /writer failed/);
      assert.equal(await fs.readFile(destination, 'utf8'), directWrites ? 'partial' : 'cached');
      assert.deepEqual(await fs.readdir(output), ['asset']);
      await io.writeFile(destination.toUpperCase(), 'case', 'utf8', undefined, undefined, output, res, crawler.pipeline);
      assert.equal(await fs.readFile(destination, 'utf8'), 'case');
      const otherDrive = path.parse(output).root.toLowerCase() === 'c:\\' ? 'D:\\' : 'C:\\';
      for (const escaped of [path.join(output, '..', 'escape'), otherDrive + 'wse-escape']) {
        await assert.rejects(io.writeFile(escaped, 'bad', 'utf8', undefined, undefined, output, res, crawler.pipeline), /escapes/);
      }
      await fs.symlink(outside, path.join(output, 'junction'), 'junction');
      await assert.rejects(io.writeFile(path.join(output, 'junction', 'asset'), 'bad',
        'utf8', undefined, undefined, output, res, crawler.pipeline), /symlink/);
      assert.deepEqual(await fs.readdir(outside), []);
      const alias = path.join(root, 'alias-' + directWrites);
      await fs.symlink(output, alias, 'junction');
      await io.writeFile(path.join(alias, 'trusted'), 'ok', 'utf8', undefined, undefined, alias, res, crawler.pipeline);
      assert.equal(await fs.readFile(path.join(output, 'trusted'), 'utf8'), 'ok');
      const first = await createFilePublication(destination, crawler.signal, output, false, res, crawler);
      try {
        await assert.rejects(createFilePublication(destination.toUpperCase(), crawler.signal, output.toUpperCase(),
          false, {...res, publicationOwner: 'two'}, crawler),
        {code: 'ERR_OUTPUT_CONFLICT'});
      } finally { await first.cleanup(); }
      const link = path.join(output, 'file-link');
      const target = path.join(outside, 'target');
      await fs.writeFile(target, 'keep');
      let fileSymlink = true;
      try { await fs.symlink(target, link, 'file'); }
      catch (error) {
        if (error.code !== 'EPERM') throw error;
        limitations.push(`${directWrites ? 'direct' : 'atomic'} file symlink: EPERM`);
        fileSymlink = false;
      }
      if (fileSymlink && directWrites) {
        await assert.rejects(io.writeFile(link, 'new', 'utf8', undefined, undefined, output, res, crawler.pipeline), /symlink/);
      } else if (fileSymlink) {
        await io.writeFile(link, 'new', 'utf8', undefined, undefined, output, res, crawler.pipeline);
        assert.equal((await fs.lstat(link)).isSymbolicLink(), false);
      }
      assert.equal(await fs.readFile(target, 'utf8'), 'keep');
    } finally { await crawler.dispose(); }
    checks.push(`${directWrites ? 'direct' : 'atomic'} publication, cleanup, case, drive containment, junctions`);
  }
  const source = path.join(root, 'source space #%');
  await fs.mkdir(source);
  // Resource construction expects localSrcRoot in the same URL spelling as url.
  const sourceUrlRoot = pathToFileURL(source).href.slice('file:///'.length);
  const bytes = Buffer.from([0, 255, 128, 42]);
  for (const type of [resource.ResourceType.Binary, resource.ResourceType.StreamingBinary]) {
    await fs.writeFile(path.join(source, type + ' bytes #%.bin'), bytes);
  }
  for (const Downloader of [downloader.SingleThreadDownloader, downloader.MultiThreadDownloader]) {
    for (const atomicWrites of [false, true]) {
      const output = path.join(root, Downloader.name + atomicWrites);
      await fs.mkdir(output);
      const config = path.join(output, 'options.mjs');
      await fs.writeFile(config, `
import {lifeCycle, options} from ${JSON.stringify(entry.href)};
export default options.defaultDownloadOptions({...lifeCycle.defaultLifeCycle(),
  localRoot: ${JSON.stringify(output)}, initialUrl: [], concurrency: 1, workerCount: 1,
  localSrcRoot: ${JSON.stringify(sourceUrlRoot)},
  atomicWrites: ${atomicWrites}, strictOutputChecks: true,
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
      const crawler = new Downloader(pathToFileURL(config).href);
      let workers = [];
      try {
        await crawler.init;
        for (const type of [resource.ResourceType.Binary, resource.ResourceType.StreamingBinary]) {
          const url = pathToFileURL(path.join(source, type + ' bytes #%.bin')).href;
          const res = resource.createResource({type, depth: 0, url, refUrl: url,
            localRoot: output, localSrcRoot: crawler.options.localSrcRoot, encoding: null});
          res.savePath = type + '.bin';
          assert.equal(crawler.addProcessedResource(res), true);
        }
        await crawler.start();
        await crawler.onIdle();
        assert.equal(crawler.downloadedCount, 2);
        for (const type of [resource.ResourceType.Binary, resource.ResourceType.StreamingBinary]) {
          assert.deepEqual(await fs.readFile(path.join(output, type + '.bin')), bytes);
        }
        workers = crawler.pool?.workers.map(info => info.worker) ?? [];
      } finally { await crawler.dispose(); }
      assert.ok(workers.every(worker => worker.threadId === -1));
      checks.push(`${Downloader.name} atomicWrites=${atomicWrites}: encoded file URLs, buffered/copy output, disposal`);
    }
  }
  console.log(JSON.stringify({node: process.version, platform: process.platform, checks, limitations}, null, 2));
} finally { await fs.rm(root, {recursive: true, force: true}); }
