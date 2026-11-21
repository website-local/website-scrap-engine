import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Run with ENGINE_ENTRY GROVE_ENTRY. GroveDOM belongs to the application;
// neither this fixture nor the engine installs or selects it by default.
const engineEntry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
  new URL('../lib/index.js', import.meta.url).href;
assert.ok(process.argv[3], 'Usage: runtime-html-parser.js ENGINE_ENTRY GROVE_ENTRY');
const groveEntry = path.resolve(process.argv[3]);
const groveRoot = path.resolve(path.dirname(groveEntry), '..');
const grovePackage = JSON.parse(await fs.readFile(path.join(groveRoot, 'package.json'), 'utf8'));
// This fixture qualifies 0.1.3. On a GroveDOM upgrade, review load/loadFast,
// parser options, node ownership and pool initialization before updating this
// pin; all eight output/discovery/disposal cases below must still pass.
assert.equal(grovePackage.version, '0.1.3');
const groveWasm = path.join(groveRoot, 'grovedom.wasm');
await fs.access(groveWasm);
const cheerioEntry = pathToFileURL(createRequire(engineEntry).resolve('cheerio')).href;
const {downloader} = await import(engineEntry);
const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-html-parser-'));
const requests = [];
const fixtures = new Map();
const server = createServer((request, response) => {
  requests.push(request.url);
  const fixture = fixtures.get(request.url);
  response.setHeader('Connection', 'close');
  if (!fixture) {
    response.writeHead(404);
    response.end('Unexpected fixture request');
    return;
  }
  response.setHeader('Content-Type', fixture.type);
  response.end(fixture.body);
});
let timer;
const deadline = new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error('HTML parser fixture timed out')), 30000);
  timer.unref();
});
void deadline.catch(() => undefined);
const bounded = promise => Promise.race([promise, deadline]);

async function snapshot(directory, prefix = '') {
  const files = [];
  const entries = await fs.readdir(directory, {withFileTypes: true});
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await snapshot(filename, relative + '/'));
    else files.push({path: relative, body: (await fs.readFile(filename)).toString('base64')});
  }
  return files;
}

try {
  await bounded(new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const nested = '<html><head></head><body><p>Nested</p><img src="/image.bin">' +
    '<a href="/page.html#nested">Nested link</a></body></html>';
  const html = '<!DOCTYPE html><html><head><title>Parser fixture</title>' +
    '<link rel="stylesheet" href="/style.css">' +
    '<style>.hero { background: url("/image.bin"); }</style></head>' +
    '<body style="background-image:url(/wide.bin)"><h1 id="home">Fixture</h1>' +
    '<img src="/image.bin" srcset="/image.bin 1x, /wide.bin 2x">' +
    '<img src="/art.svg"><svg><image href="/image.bin"></image></svg>' +
    '<a href="/page.html#part">Page</a><a href="/sitemap.xml">Sitemap</a>' +
    '<iframe srcdoc="' + nested.replaceAll('&', '&amp;').replaceAll('"', '&quot;') +
    '"></iframe></body></html>';
  const add = (url, type, body) => fixtures.set(url, {type, body});
  add('/index.html', 'text/html', html);
  add('/page.html', 'text/html', '<!DOCTYPE html><html><head><title>Page</title></head>' +
    '<body><h2 id="part">Page</h2><a href="/index.html#home">Home</a></body></html>');
  add('/mapped.html', 'text/html', '<!DOCTYPE html><html><head><title>Mapped</title></head>' +
    '<body><p>From the sitemap</p></body></html>');
  add('/style.css', 'text/css', '@import "/extra.css"; .hero { background: url("/image.bin"); }\n');
  add('/extra.css', 'text/css', '.wide { background: url("/wide.bin"); }\n');
  add('/art.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink"><image href="/image.bin"></image>' +
    '<image xlink:href="/wide.bin"></image></svg>');
  add('/sitemap.xml', 'application/xml', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    `<url><loc>${origin}/mapped.html</loc></url><url><loc> ${origin}/mapped.html </loc></url></urlset>`);
  add('/image.bin', 'application/octet-stream', Buffer.from([0, 255, 128, 1]));
  add('/wide.bin', 'application/octet-stream', Buffer.from([254, 2, 0, 129]));

  // One application module is cached per isolate, including across successive
  // compatible/fast crawls in the main process. New workers initialize their own.
  const applicationPath = path.join(root, 'application.mjs');
  await fs.writeFile(applicationPath, `
let groveReady;
let groveInitCount = 0;
export async function selectParser(variant) {
  if (variant === 'default') return {load: undefined, groveInitCount};
  if (variant === 'cheerio') {
    const cheerio = await import(${JSON.stringify(cheerioEntry)});
    return {load: cheerio.load, groveInitCount};
  }
  groveReady ??= import(${JSON.stringify(pathToFileURL(groveEntry).href)}).then(grove => {
    grove.init({wasm: ${JSON.stringify(groveWasm)}, heap: 'pool', poolSize: 4, poolMaxBytes: 8 * 1048576});
    groveInitCount++;
    return grove;
  });
  const grove = await groveReady;
  return {load: variant === 'grove-fast' ? grove.loadFast : grove.load, groveInitCount};
}
`);

  const expectedEdges = [
    [null, '/index.html'],
    ...Array.from({length: 5}, () => ['/index.html', '/image.bin']),
    ...Array.from({length: 2}, () => ['/index.html', '/wide.bin']),
    ['/index.html', '/art.svg'], ['/index.html', '/style.css'],
    ['/index.html', '/page.html#part'], ['/index.html', '/page.html#nested'],
    ['/index.html', '/sitemap.xml'], ['/page.html', '/index.html#home'],
    // Got's response URL omits the admitted #part fragment. The existing
    // processRedirectedUrl hook creates this metadata-only canonical resource
    // through processBeforeDownload; it never submits another HTTP request.
    ['/page.html', '/page.html'],
    ['/style.css', '/extra.css'], ['/style.css', '/image.bin'],
    ['/extra.css', '/wide.bin'], ['/art.svg', '/image.bin'],
    ['/art.svg', '/wide.bin'], ['/sitemap.xml', '/mapped.html']
  ].map(edge => JSON.stringify(edge)).sort();
  const expectedFiles = [...fixtures.keys()].map(url => '127.0.0.1' + url).sort();
  let baseline;
  const results = [];

  for (const variant of ['default', 'cheerio', 'grove', 'grove-fast']) {
    for (const [mode, Downloader] of [
      ['main', downloader.SingleThreadDownloader],
      ['worker', downloader.MultiThreadDownloader]
    ]) {
      const caseRoot = path.join(root, variant + '-' + mode);
      const outputRoot = path.join(caseRoot, 'output');
      await fs.mkdir(caseRoot);
      const optionsPath = path.join(caseRoot, 'options.mjs');
      await fs.writeFile(optionsPath, `
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {threadId} from 'node:worker_threads';
import {lifeCycle, options, resource} from ${JSON.stringify(engineEntry)};
import {selectParser} from ${JSON.stringify(pathToFileURL(applicationPath).href)};
const variant = ${JSON.stringify(variant)};
const trace = ${JSON.stringify(path.join(caseRoot, 'events-'))} + threadId + '.jsonl';
const record = entry => appendFileSync(trace, JSON.stringify({threadId, ...entry}) + '\\n');
const relative = url => { const parsed = new URL(url); return parsed.pathname + parsed.search + parsed.hash; };
let selected;
let initialized = 0;
let documentCount = 0;
const ids = new WeakMap();
const lc = lifeCycle.defaultLifeCycle();
// These are application-selected types: the legacy detector preserves Binary
// for CSS/SVG discoveries and recognizes only the /sitemaps/ URL convention.
const fixtureTypes = new Map([
  ['/style.css', resource.ResourceType.Css],
  ['/extra.css', resource.ResourceType.Css],
  ['/art.svg', resource.ResourceType.Svg],
  ['/sitemap.xml', resource.ResourceType.SiteMap]
]);
lc.detectResourceType.push((url, type) =>
  fixtureTypes.get(new URL(url, ${JSON.stringify(origin)}).pathname) ?? type);
lc.init.push(async () => {
  assert.equal(initialized++, 0, 'application init runs once per pipeline');
  selected = await selectParser(variant);
  record({event: 'init', initialized, groveInitCount: selected.groveInitCount});
});
function loadHtml(...args) {
  assert.equal(initialized, 1);
  assert.equal(typeof selected.load, 'function');
  const document = selected.load(...args);
  const id = ++documentCount;
  ids.set(document, id);
  record({event: 'load', id});
  const dispose = document.dispose;
  let disposed = false;
  document.dispose = () => {
    assert.equal(disposed, false, 'each document is released exactly once');
    disposed = true;
    dispose?.call(document);
    if (variant.startsWith('grove')) assert.throws(() => document.html(), /disposed/i);
    record({event: 'dispose', id});
  };
  return document;
}
lc.processBeforeDownload.push((resource, _element, parent) => {
  record({event: 'discovery', parent: parent ? new URL(parent.url).pathname : null,
    url: relative(resource.url), type: resource.type,
    savePath: resource.savePath, replacePath: resource.replacePath});
  return resource;
});
lc.statusChange.push(async resource => {
  const document = resource.meta.doc;
  if (!document) return;
  const id = ids.get(document);
  record({event: 'status-start', id});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resource.meta.doc, document, 'status listener retains its document');
    document.html();
    record({event: 'status-done', id});
  } catch (error) {
    record({event: 'failure', error: String(error)});
    throw error;
  }
});
lc.processAfterDownload.push((resource, _submit, _options, pipeline) => {
  if (resource.meta.doc) void pipeline.notifyStatusChange(resource, 'processAfterDownload');
  return resource;
});
export default options.defaultDownloadOptions({
  ...lc,
  ...(variant === 'default' ? {} : {loadHtml}),
  localRoot: ${JSON.stringify(outputRoot)},
  initialUrl: [${JSON.stringify(origin + '/index.html')}],
  maxDepth: 3, concurrency: 2, workerCount: 2, waitForInitBeforeIdle: true,
  req: {retry: {limit: 0}, timeout: {request: 2000}},
  createLogger: () => ({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false})
});
`);
      requests.length = 0;
      const crawler = new Downloader(pathToFileURL(optionsPath).href);
      const errors = [];
      crawler.handleError = (...args) => errors.push(args);
      try {
        await bounded(crawler.init);
        crawler.start();
        await bounded(crawler.onIdle());
        assert.deepEqual(errors, [], variant + '/' + mode + ' resource errors');
        const requested = [...requests].sort();
        const expected = [...fixtures.keys()].sort();
        const requestContext = variant + '/' + mode + ': ' + JSON.stringify({
          requested,
          missing: expected.filter(url => !requested.includes(url)),
          unexpected: requested.filter(url => !fixtures.has(url))
        });
        assert.deepEqual(requested, expected, 'exact HTTP request set; ' + requestContext);
        assert.equal(crawler.downloadedCount, fixtures.size, 'completed downloads; ' + requestContext);
      } finally {
        await crawler.dispose();
      }
      assert.deepEqual(errors, [], variant + '/' + mode + ' disposal errors');
      const events = [];
      for (const filename of (await fs.readdir(caseRoot)).filter(name => name.endsWith('.jsonl')).sort()) {
        const lines = (await fs.readFile(path.join(caseRoot, filename), 'utf8')).trim().split('\n');
        const trace = lines.map(line => JSON.parse(line));
        const initialized = trace.filter(event => event.event === 'init');
        assert.equal(initialized.length, 1, filename + ': exactly one application initialization');
        assert.equal(initialized[0].initialized, 1);
        if (variant.startsWith('grove')) assert.equal(initialized[0].groveInitCount, 1);
        const live = new Set();
        for (const event of trace) {
          assert.notEqual(event.event, 'failure', event.error);
          if (event.event === 'load') {
            assert.equal(live.has(event.id), false);
            live.add(event.id);
          } else if (event.event === 'dispose') {
            assert.equal(live.delete(event.id), true, filename + ': disposal owns a live document');
          } else if (event.event === 'status-done' && event.id !== undefined) {
            assert.equal(live.has(event.id), true, filename + ': status settles before disposal');
          }
        }
        assert.equal(live.size, 0, filename + ': no remaining document owners');
        events.push(...trace);
      }
      const initializations = events.filter(event => event.event === 'init');
      assert.equal(initializations.length, mode === 'worker' ? 3 : 1, 'main and both workers initialize');
      assert.equal(initializations.filter(event => event.threadId === 0).length, 1);
      const loads = events.filter(event => event.event === 'load');
      assert.equal(loads.length, variant === 'default' ? 0 : 6, 'five resource documents and one nested srcdoc');
      if (mode === 'worker') assert.ok(loads.every(event => event.threadId !== 0));
      assert.equal(events.filter(event => event.event === 'dispose').length, loads.length);
      assert.equal(events.filter(event => event.event === 'status-start').length, 5);
      assert.equal(events.filter(event => event.event === 'status-done').length, 5);

      const discoveries = events.filter(event => event.event === 'discovery')
        .map(({parent, url, type, savePath, replacePath}) => ({parent, url, type, savePath, replacePath}))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assert.deepEqual(discoveries.map(({parent, url}) => JSON.stringify([parent, url])).sort(), expectedEdges);
      const files = await snapshot(outputRoot);
      assert.deepEqual(files.map(file => file.path).sort(), expectedFiles);
      const read = name => Buffer.from(files.find(file => file.path === '127.0.0.1/' + name).body, 'base64');
      assert.deepEqual(read('image.bin'), fixtures.get('/image.bin').body);
      assert.deepEqual(read('wide.bin'), fixtures.get('/wide.bin').body);
      assert.equal(read('style.css').toString(), '@import "extra.css"; .hero { background: url("image.bin"); }\n');
      assert.equal(read('extra.css').toString(), '.wide { background: url("wide.bin"); }\n');
      const savedHtml = read('index.html').toString();
      for (const replacement of ['src="image.bin"', 'src="art.svg"', 'href="style.css"',
        'href="page.html#part"', 'href="sitemap.xml"', 'page.html#nested', 'srcset="image.bin 1x, wide.bin 2x"']) {
        assert.ok(savedHtml.includes(replacement), replacement);
      }
      const savedSvg = read('art.svg').toString();
      assert.ok(savedSvg.includes('href="image.bin"'));
      assert.ok(savedSvg.includes('xlink:href="wide.bin"'));
      if (baseline) {
        assert.deepEqual(files, baseline.files, variant + '/' + mode + ': exact saved-byte parity');
        assert.deepEqual(discoveries, baseline.discoveries, variant + '/' + mode + ': exact discovery parity');
      } else baseline = {files, discoveries};
      results.push({parser: variant, mode, requests: requests.length, files: files.length,
        discoveries: discoveries.length - 1, documents: loads.length, initializations: initializations.length});
    }
  }
  console.log(JSON.stringify({engine: fileURLToPath(engineEntry), grove: grovePackage.version, cases: results}));
} finally {
  clearTimeout(timer);
  try {
    if (server.listening) await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}
