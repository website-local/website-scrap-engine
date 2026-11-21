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
import {parseRefreshLink, processHtmlMetaRefresh} from '../../src/life-cycle/process-html-meta.js';
import {saveHtmlToDisk} from '../../src/life-cycle/save-html-to-disk.js';
import {saveResourceToDisk} from '../../src/life-cycle/save-resource-to-disk.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'wse-output-boundaries-')); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

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
