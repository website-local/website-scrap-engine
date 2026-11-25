import {afterEach, beforeEach, expect, test} from '@jest/globals';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {load} from 'cheerio';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {parseCssUrlMatches} from '../../src/life-cycle/parse-css-urls.js';
import {processCssText} from '../../src/life-cycle/process-css.js';
import {processHtml} from '../../src/life-cycle/process-html.js';
import {processSvg} from '../../src/life-cycle/process-svg.js';
import {parseRefreshLink, processHtmlMetaRefresh} from '../../src/life-cycle/process-html-meta.js';
import {saveHtmlToDisk} from '../../src/life-cycle/save-html-to-disk.js';
import {saveResourceToDisk} from '../../src/life-cycle/save-resource-to-disk.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'wse-output-boundaries-')); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

test.each([ResourceType.Html, ResourceType.Svg])('type %s preserves links to a literal .html filename', async type => {
  const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root});
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const parent = Object.assign(createResource({type, depth: 0, localRoot: root,
    url: 'https://example.org/dir/parent.' + (type === ResourceType.Html ? 'html' : 'svg'),
    refUrl: 'https://example.org/'}), {body: '<a href="https://example.org/dir/.html">target</a>', encoding: 'utf8' as const});
  const children: Resource[] = [];
  await (type === ResourceType.Html ? processHtml : processSvg)(parent, value => {
    children.push(...(Array.isArray(value) ? value : [value]));
  }, options, pipeline);
  expect(children).toHaveLength(1);
  await saveResourceToDisk(Object.assign(children[0], {body: 'target bytes'}), options, pipeline);
  await (type === ResourceType.Html ? saveHtmlToDisk : saveResourceToDisk)(parent, options, pipeline);
  const parentFile = join(root, parent.savePath);
  const href = load(await fs.readFile(parentFile, 'utf8'))('a').attr('href');
  expect(href).toBe('.html');
  expect(await fs.readFile(new URL(href!, pathToFileURL(parentFile)), 'utf8')).toBe('target bytes');
});

test.each([
  [ResourceType.Html, '/'], [ResourceType.Html, '/guide'], [ResourceType.Html, '/guide/'],
  [ResourceType.Html, '/guide.htm'], [ResourceType.Html, '/guide.html'],
  [ResourceType.Svg, '/image.svg'], [ResourceType.Svg, '/dir/image.svg']
] as const)('type %s self links resolve to the written document at %s', async (type, pathname) => {
  const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root});
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const url = 'https://example.org' + pathname;
  const parent = Object.assign(createResource({type, depth: 0, localRoot: root, url, refUrl: url}), {
    body: `<a href="${url}">self</a><a href="${url}#section">absolute fragment</a><a href="#section">fragment</a>`,
    encoding: 'utf8' as const
  });
  await (type === ResourceType.Html ? processHtml : processSvg)(parent, () => undefined, options, pipeline);
  await (type === ResourceType.Html ? saveHtmlToDisk : saveResourceToDisk)(parent, options, pipeline);
  const file = join(root, parent.savePath);
  const written = await fs.readFile(file, 'utf8');
  const doc = load(written);
  for (let index = 0; index < 3; index++) {
    const href = doc('a').eq(index).attr('href');
    expect(href).toBe(index === 0 ? '' : '#section');
    const target = new URL(href!, pathToFileURL(file));
    expect(fileURLToPath(target)).toBe(file);
    expect(await fs.readFile(target, 'utf8')).toBe(written);
  }
});

test.each([false, true])('CSS honors empty replacements for repeated URLs (discard %s)', async discard => {
  const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root,
    processBeforeDownload: [res => {
      res.replacePath = '';
      res.shouldBeDiscardedFromDownload = discard;
      return res;
    }]});
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const parent = Object.assign(createResource({type: ResourceType.Css, depth: 0,
    url: 'https://example.org/style.css', refUrl: 'https://example.org/', localRoot: root}), {body: ''});
  const children: Resource[] = [];
  const css = '/* asset.png */a{background:url("asset.png")}b{background:url(\'asset.png\')}';
  expect(await processCssText(css, parent, options, pipeline, 1, children))
    .toBe('/* asset.png */a{background:url("")}b{background:url(\'\')}');
  expect(children).toHaveLength(discard ? 0 : 1);
});

test.each([ResourceType.Binary, ResourceType.StreamingBinary].flatMap(type =>
  ['source', 'source space#%25'].flatMap(source => [false, true].flatMap(trailing =>
    [false, true].map(policy => ({type, source, trailing, policy}))))))(
  'local links reach bytes: $type / $source / trailing=$trailing / policy=$policy', async ({type, source, trailing, policy}) => {
    const sourceRoot = join(root, source);
    const destination = join(root, 'output');
    await fs.mkdir(sourceRoot);
    const names = ['asset.bin', 'space name.bin', 'hash#percent%.bin',
      'literal%20.bin', 'literal%25.bin', 'literal%2F.bin', 'literal%23.bin', 'literal%2520.bin'];
    const diskNames = ['asset.bin', 'space name.bin', 'hash%23percent%.bin', ...names.slice(3)];
    for (const name of names) await fs.writeFile(join(sourceRoot, name), 'bytes for ' + name);
    await fs.mkdir(destination);
    for (const name of diskNames) await fs.writeFile(join(destination, name), 'cached bytes');
    const input = join(sourceRoot, 'index.html');
    await fs.writeFile(input, names.map(name => '<img src="' + encodeURIComponent(name) + '">').join(''));
    const policyPaths: string[] = [];
    const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: destination,
      localSrcRoot: sourceRoot + (trailing ? '/' : ''),
      existingResource: policy ? ({stage, localPath}) => {
        policyPaths.push(stage + ':' + localPath);
        return 'overwrite';
      } : undefined,
      processBeforeDownload: [res => { res.type = type; return res; }]});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const parent = pipeline.createResource(ResourceType.Html, 0, pathToFileURL(input).href, pathToFileURL(input).href);
    const downloaded = await pipeline.download(parent);
    if (!downloaded || downloaded === true) throw new Error('Expected HTML body');
    const children: Resource[] = [];
    await processHtml(downloaded, value => {
      children.push(...(Array.isArray(value) ? value : [value]));
    }, options, pipeline);
    expect(children).toHaveLength(names.length);
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      const savePath = child.savePath;
      expect(savePath).toBe(encodeURIComponent(names[index]));
      const body = await pipeline.download(child);
      if (type === ResourceType.StreamingBinary) expect(body).toBe(true);
      else {
        if (!body || body === true) throw new Error('Expected binary body');
        await pipeline.saveToDisk(body);
      }
      expect(child.savePath).toBe(savePath);
    }
    await saveHtmlToDisk(downloaded, options, pipeline);
    const output = join(destination, 'index.html');
    const doc = load(await fs.readFile(output, 'utf8'));
    for (let index = 0; index < names.length; index++) {
      const url = new URL(doc('img').eq(index).attr('src')!, pathToFileURL(output));
      expect(fileURLToPath(url)).toBe(join(destination, diskNames[index]));
      expect(await fs.readFile(url, 'utf8')).toBe('bytes for ' + names[index]);
    }
    expect(policyPaths).toEqual(policy ? diskNames.flatMap(name =>
      ['download:', 'saveToDisk:'].map(stage => stage + join(destination, name))) : []);
  });

test.each([ResourceType.Binary, ResourceType.StreamingBinary].flatMap(type =>
  [false, true].map(policy => ({type, policy}))))(
  'custom save paths decode percent escapes once: $type / policy=$policy', async ({type, policy}) => {
    const input = join(root, 'source%20%.bin');
    await fs.writeFile(input, 'source bytes');
    const policyPaths: string[] = [];
    const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root,
      existingResource: policy ? ({stage, localPath}) => {
        policyPaths.push(stage + ':' + localPath);
        return 'overwrite';
      } : undefined});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const expectedPaths: string[] = [];
    for (const kind of ['explicit', 'generator']) {
      const savePath = kind + '/literal%2520%25.bin';
      const destination = join(root, kind, 'literal%20%.bin');
      await fs.mkdir(join(root, kind));
      await fs.writeFile(destination, 'cached bytes');
      const resource = createResource({type, depth: 0, localRoot: root, localSrcRoot: root,
        url: pathToFileURL(input).href, refUrl: pathToFileURL(input).href, refSavePath: 'index.html',
        savePath: kind === 'explicit' ? savePath : undefined,
        generateSavePathFn: () => savePath});
      const downloaded = await pipeline.download(resource);
      if (type === ResourceType.StreamingBinary) expect(downloaded).toBe(true);
      else {
        if (!downloaded || downloaded === true) throw new Error('Expected binary body');
        await pipeline.saveToDisk(downloaded);
      }
      expect(resource.savePath).toBe(savePath);
      expect(await fs.readFile(destination, 'utf8')).toBe('source bytes');
      expect(fileURLToPath(new URL(resource.replacePath, pathToFileURL(join(root, 'index.html')))))
        .toBe(destination);
      expectedPaths.push('download:' + destination, 'saveToDisk:' + destination);
    }
    expect(policyPaths).toEqual(policy ? expectedPaths : []);
  });

test.each([false, true])('redirect HTML and its script reach written encoded targets (explicit path: %s)', async explicit => {
  const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root});
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const resource = Object.assign(createResource({type: ResourceType.Html, depth: 0,
    url: 'https://example.org/old', refUrl: 'https://example.org/', localRoot: root,
    savePath: 'example.org/old%23page.html'}), {body: 'redirected body', encoding: 'utf8' as const});
  resource.redirectedUrl = 'https://example.org/new%23page';
  if (explicit) resource.redirectedSavePath = 'example.org/new%2Fpage#hash&copy;\'quote.html';
  await saveHtmlToDisk(resource, options, pipeline);
  const oldFile = join(root, 'example.org', 'old%23page.html');
  const html = load(await fs.readFile(oldFile, 'utf8'));
  const refresh = html('meta[http-equiv="refresh"]').attr('content')!.slice('0; url='.length);
  const target = new URL(refresh, pathToFileURL(oldFile));
  const diskName = explicit ? 'new%2Fpage#hash&copy;\'quote.html' : 'new%23page.html';
  expect(fileURLToPath(target)).toBe(join(root, 'example.org', diskName));
  expect(await fs.readFile(target, 'utf8')).toBe('redirected body');
  expect(resource.body).toBeUndefined();
  let jsTarget = '';
  runInNewContext(html('script').text(), {location: {
    hash: '#section', replace: (value: string) => { jsTarget = value; }
  }});
  expect(new URL(jsTarget, pathToFileURL(oldFile)).href).toBe(target.href + '#section');
});

test.each([32, 33])('CSS and refresh fallback links reach saved files with %i spaces', async spaces => {
  const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root,
    generateSavePath: (_uri, html) => 'example.org/' +
      (html ? 'child%23$&.html' : 'asset%2F$&.bin')});
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  for (const length of [16, 257]) {
    const target = 'https://example.org/' + 'a'.repeat(length);
    const padding = ' '.repeat(spaces);
    const parent = Object.assign(createResource({type: ResourceType.Html, depth: 0,
      url: 'https://example.org/parent', refUrl: 'https://example.org/', localRoot: root,
      savePath: 'example.org/parent.html'}), {body: '', encoding: 'utf8' as const});
    const document = load('<meta http-equiv="refresh"><style></style>');
    document('meta').attr('content', '0;' + padding + 'url="' + target + '"');
    const assets: Resource[] = [];
    const css = 'a{background:url(' + padding + '"' + target + '")}b{background:url("' + target + '")}';
    document('style').text(await processCssText(css, parent, options, pipeline, 1, assets));
    expect(assets).toHaveLength(1);
    parent.meta.doc = document;
    const pages: Resource[] = [];
    await processHtmlMetaRefresh(parent, value => {
      pages.push(...(Array.isArray(value) ? value : [value]));
    }, options, pipeline);
    expect(pages).toHaveLength(1);
    for (const resource of [...assets, ...pages]) {
      const child = Object.assign(resource, {body: 'bytes for ' + resource.type, encoding: 'utf8' as const});
      await (resource.type === ResourceType.Html ? saveHtmlToDisk : saveResourceToDisk)(child, options, pipeline);
    }
    await saveHtmlToDisk(parent, options, pipeline);
    const parentFile = join(root, 'example.org', 'parent.html');
    const written = load(await fs.readFile(parentFile, 'utf8'));
    const urls = parseCssUrlMatches(written('style').text()).map(match => match.url);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
    const refresh = parseRefreshLink(written('meta').attr('content')!);
    expect(refresh).toBeDefined();
    for (const [url, child, diskName] of [
      [urls[0], assets[0], 'asset%2F$&.bin'], [refresh!, pages[0], 'child%23$&.html']
    ] as const) {
      const local = new URL(url, pathToFileURL(parentFile));
      expect(fileURLToPath(local)).toBe(join(root, 'example.org', diskName));
      expect(await fs.readFile(local, 'utf8')).toBe('bytes for ' + child.type);
    }
  }
});
