// noinspection ES6PreferShortImport

import {describe, expect, test} from '@jest/globals';
import type {ProcessingLifeCycle} from '../../src/life-cycle/types.js';
import {createResource, ResourceType} from '../../src/resource.js';
import {
  PipelineExecutorImpl
} from '../../src/downloader/pipeline-executor-impl.js';
import {sources} from '../../src/sources.js';
import {load} from 'cheerio';
import type {DownloadOptions} from '../../src/options.js';
import {resHtml} from './save-mock-fs.js';
import {processHtml} from '../../src/life-cycle/process-html.js';
import {
  processHtmlMetaRefresh
} from '../../src/life-cycle/process-html-meta.js';

/**
 * Get a copy of default life cycle
 */
const testLifeCycle = (): ProcessingLifeCycle => ({
  init: [],
  linkRedirect: [],
  detectResourceType: [],
  generateSavePath: [],
  createResource,
  processBeforeDownload: [],
  download: [
  ],
  processAfterDownload: [
  ],
  saveToDisk: [],
  dispose: [],
  statusChange: []
});

const testPipeline = new PipelineExecutorImpl(testLifeCycle(), {}, {
  localRoot: '/mnt/test/',
  maxDepth: 2,
  concurrency: 1,
  encoding: {} as DownloadOptions['encoding'],
  meta: {},
});

function toHtml(selector: string) {
  const html = load('<html lang="en"><body></body></html>');
  const body = html('body');
  const parts = selector.split(' ');
  let element: ReturnType<typeof html> | void = undefined;
  for (const part of parts) {
    const parsed = part.split(/[[\]]/);
    let tag = parsed[0];
    let currHtml: string;
    if (!tag || tag === '*') {
      tag = selector.startsWith('svg') ? 'g' : 'div';
    }
    const attr = parsed[1];
    const attr2 = parsed[3];
    if (attr2 && attr) {
      const parsedAttr = attr.split(/[ ="'*]+/);
      const attrName = parsedAttr[0].replace(/\\/g, '');
      const attrValue = parsedAttr[1]?.replace(/\\/g, '') || '';
      const parsedAttr2 = attr2.split(/[ ="'*]+/);
      const attrName2 = parsedAttr2[0].replace(/\\/g, '');
      const attrValue2 = parsedAttr2[1]?.replace(/\\/g, '') || '';
      currHtml = `<${tag} ${attrName}="${attrValue}" ${attrName2}="${attrValue2}"></${tag}>`;
    } else if (attr) {
      const parsedAttr = attr.split(/[ ="'*]+/);
      const attrName = parsedAttr[0].replace(/\\/g, '');
      const attrValue = parsedAttr[1]?.replace(/\\/g, '') || '';
      currHtml = `<${tag} ${attrName}="${attrValue}"></${tag}>`;
    } else {
      currHtml = `<${tag}></${tag}>`;
    }
    const current = html(currHtml);
    if (!element) {
      body.append(current);
    } else {
      element.append(current);
    }
    element = current;
  }
  return html;

}

// https://github.com/website-local/website-scrap-engine/issues/1092
describe('process-html', function () {
  test('non-html-resources', async function () {
    const res = resHtml('https://example.com/dir01/index.bin', '');
    res.type = ResourceType.Binary;
    const processed =
      await processHtml(res, () => {}, testPipeline.options, testPipeline);
    expect(processed).toBeTruthy();
    expect(processed!.meta.doc).toBeFalsy();
  });

  test('parse-html', async function () {
    const res = resHtml('https://example.com/dir01/index.bin', '');
    res.body = '<html><body></body></html>';
    const processed =
      await processHtml(res, () => {}, testPipeline.options, testPipeline);
    expect(processed).toBeTruthy();
    expect(processed!.meta.doc).toBeTruthy();
  });

  test('simple-attr', async function () {
    for (const {selector, attr, type} of sources) {
      if (type === ResourceType.CssInline || attr === 'srcset' || !attr) {
        continue;
      }
      if (selector === 'frame[src]') {
        // A frame should be used within a <frameset>.
        continue;
      }
      const html = toHtml(selector);
      html(selector).attr(attr, 'https://example.com/static/test.bin');
      const res = resHtml('https://example.com/dir01/index.html', '');
      res.meta.doc = html;
      const processed =
        await processHtml(res, () => {}, testPipeline.options, testPipeline);
      expect(processed).toBeTruthy();
      expect(processed!.meta.doc).toBe(html);
      // console.log(selector, attr, html(selector).attr(attr), html.html());
      if (type === ResourceType.Html) {
        expect(html(selector).attr(attr)).toBe('../static/test.bin.html');
      } else {
        expect(html(selector).attr(attr)).toBe('../static/test.bin');
      }
    }
  });

  test('inline-css', async function () {
    const html = load(`<html lang="en">
<head>
<style>
/* url("https://cdn.example.com/comment.webp") */
div {
  background-image: url("https://cdn.example.com/img.webp");
  content: "https://cdn.example.com/img.webp";
}
</style>
<title></title>
</head>
<body><div>
<span style="background-image: url('https://cdn.example.com/img2.webp')"></span>
</div></body></html>`);
    const res = resHtml('https://example.com/dir01/index.html', '');
    res.meta.doc = html;
    const processed =
      await processHtml(res, () => {}, testPipeline.options, testPipeline);
    expect(processed).toBeTruthy();
    expect(processed!.meta.doc).toBe(html);
    expect(html('span').attr('style')).toBeTruthy();
    expect(html('style').text()).toBeTruthy();
    expect(html('span').attr('style')!.includes('../../cdn.example.com/img2.webp')).toBeTruthy();
    expect(html('style').text()!.includes('../../cdn.example.com/img.webp')).toBeTruthy();
    expect(html('style').text()!.includes('https://cdn.example.com/comment.webp')).toBeTruthy();
    expect(html('style').text()!.includes('content: "https://cdn.example.com/img.webp"')).toBeTruthy();
  });

  test('srcset', async function () {
    const html = load(`<html lang="en">
<body><div class="box">
  <img
    src="https://example.com/clock-demo-200px.png"
    alt="Test"
    srcset="https://example.com/clock-demo-400px.png 2x" />
</div></body></html>`);
    const res = resHtml('https://example.com/dir01/index.html', '');
    res.meta.doc = html;
    const processed =
      await processHtml(res, () => {}, testPipeline.options, testPipeline);
    expect(processed).toBeTruthy();
    expect(processed!.meta.doc).toBe(html);
    expect(html('img').attr('src')).toBeTruthy();
    expect(html('img').attr('src')).toBe('../clock-demo-200px.png');
    expect(html('img').attr('srcset')).toBeTruthy();
    expect(html('img').attr('srcset')).toBe('../clock-demo-400px.png 2x');
  });

  // https://github.com/website-local/website-scrap-engine/issues/1081
  test('srcdoc', async function () {
    for (const {selector, attr, type} of sources) {
      if (type === ResourceType.CssInline || attr === 'srcset' || !attr) {
        continue;
      }
      // WTF with svg?
      if (selector === 'frame[src]' || selector.startsWith('svg')) {
        // A frame should be used within a <frameset>.
        continue;
      }
      const html = toHtml(selector);
      html(selector).attr(attr, 'https://example.com/static/test.bin');
      const res = resHtml('https://example.com/dir01/index.html', '');
      const outerPage = load(`<html lang="en">
<body><iframe srcdoc=""></body></html>`);
      outerPage('iframe').attr('srcdoc', html.html());
      res.meta.doc = outerPage;
      const processed =
        await processHtml(res, () => {}, testPipeline.options, testPipeline);
      expect(processed).toBeTruthy();
      expect(processed!.meta.doc).toBe(outerPage);
      const innerSrcDoc = outerPage('iframe').attr('srcdoc');
      expect(innerSrcDoc).toBeTruthy();
      const innerPage = load(innerSrcDoc!);
      expect(innerSrcDoc).toBeTruthy();
      // console.log(selector, attr, html(selector).attr(attr), html.html(), innerPage.html());
      if (type === ResourceType.Html) {
        expect(innerPage(selector).attr(attr)).toBe('../static/test.bin.html');
      } else {
        expect(innerPage(selector).attr(attr)).toBe('../static/test.bin');
      }
    }
  });

  // meta refresh rewrite must not mis-handle '$' sequences in the replace path.
  // '$$' survives save-path sanitization (unlike '&', which becomes '_'), so
  // it reaches replacePath verbatim. String.prototype.replace would collapse
  // '$$' into a single '$' in the replacement string and corrupt the path.
  test('meta-refresh-dollar-in-replace-path', async function () {
    const html = load(`<html lang="en"><head>
<meta http-equiv="refresh" content="0; url=https://example.com/a$$b.html">
</head><body></body></html>`);
    const res = resHtml('https://example.com/dir01/index.html', '');
    res.meta.doc = html;
    const processed = await processHtmlMetaRefresh(
      res, () => {}, testPipeline.options, testPipeline);
    expect(processed).toBeTruthy();
    const content = html('meta[http-equiv="refresh"]').attr('content');
    // '$$' must survive verbatim; the old replace()-based rewrite would have
    // collapsed it to '$' (producing '../a$b.html').
    expect(content).toBe('0; url=../a$$b.html');
  });

});


describe('inline style processing', () => {
  test.each([false, true])('preserves unchanged CSS after hook mutation=%s', async mutate => {
    const css = '.asset { background: url(icon.png); content: "<b>&"; }';
    const res = resHtml('https://example.com/index.html', '<style>' + css + '</style>');
    const lifeCycle = testLifeCycle();
    lifeCycle.processBeforeDownload = [resource => {
      if (mutate) res.meta.doc!('style').text('hook mutation');
      resource.replacePath = resource.rawUrl;
      return resource;
    }];
    const pipeline = new PipelineExecutorImpl(lifeCycle, {}, testPipeline.options);
    const submitted: string[] = [];
    await processHtml(res, value => {
      for (const item of Array.isArray(value) ? value : [value]) submitted.push(item.url);
    }, pipeline.options, pipeline);
    expect(res.meta.doc!('style').html()).toBe(css);
    expect(submitted).toEqual(['https://example.com/icon.png']);
  });

  test('writes changed CSS while preserving surrounding text', async () => {
    const res = resHtml('https://example.com/index.html', '<style>/* keep */ .asset { background: url(icon.png); }</style>');
    const lifeCycle = testLifeCycle();
    lifeCycle.processBeforeDownload = [resource => {
      resource.replacePath = 'assets/icon.png';
      return resource;
    }];
    const pipeline = new PipelineExecutorImpl(lifeCycle, {}, testPipeline.options);
    await processHtml(res, () => {}, pipeline.options, pipeline);
    expect(res.meta.doc!('style').html()).toBe('/* keep */ .asset { background: url(assets/icon.png); }');
  });
});

describe('source selection between hooks', () => {
  test('observes different-tag insertions and changed source rows after a skipped link', async () => {
    const res = resHtml('https://example.com/index.html', '<img src="/first"><input src="/removed">');
    const options = {...testPipeline.options, sources: [
      {selector: 'embed[src]', attr: 'src', type: ResourceType.Binary},
      {selector: 'img[src]', attr: 'src', type: ResourceType.Binary},
      {selector: 'input[src]', attr: 'src', type: ResourceType.Binary}
    ]};
    const observed: string[] = [];
    const lifeCycle = testLifeCycle();
    lifeCycle.linkRedirect = [async url => {
      observed.push(url);
      if (url === '/first') {
        await Promise.resolve();
        res.meta.doc!('input').remove();
        res.meta.doc!('body').append('<video src="/inserted"></video>');
        options.sources[2].selector = 'video[src]';
        return;
      }
      return url;
    }];
    const pipeline = new PipelineExecutorImpl(lifeCycle, {}, options);
    await processHtml(res, () => {}, options, pipeline);
    expect(observed).toEqual(['/first', '/inserted']);
  });

  test.each([false, true])('refreshes matches after an asynchronous hook with tag hints=%s', async hinted => {
    const res = resHtml('https://example.com/index.html', '');
    res.meta.doc = load('<img data-first="/first"><img id="removed" data-next="/removed">');
    const options = {...testPipeline.options, sources: [
      {selector: 'img[data-missing]', attr: 'data-missing', type: ResourceType.Binary, tag: hinted ? 'img' : undefined},
      {selector: 'img[data-first]', attr: 'data-first', type: ResourceType.Binary, tag: hinted ? 'img' : undefined},
      {selector: 'img[data-next]', attr: 'data-next', type: ResourceType.Binary, tag: hinted ? 'img' : undefined}
    ]};
    const lifeCycle = testLifeCycle();
    const observed: string[] = [];
    lifeCycle.processBeforeDownload = [async resource => {
      observed.push(resource.url);
      if (resource.url.endsWith('/first')) {
        await Promise.resolve();
        res.meta.doc!('#removed').remove();
        res.meta.doc!('body').append('<img data-next="/inserted">');
      }
      return resource;
    }];
    const pipeline = new PipelineExecutorImpl(lifeCycle, {}, options);
    await processHtml(res, () => {}, options, pipeline);
    expect(observed).toEqual(['https://example.com/first', 'https://example.com/inserted']);
  });

  test.each([false, true])('keeps selections local to concurrent documents with tag hints=%s', async hinted => {
    const options = {...testPipeline.options, sources: [
      {selector: 'img[data-missing]', attr: 'data-missing', type: ResourceType.Binary, tag: hinted ? 'img' : undefined},
      {selector: 'img[src]', attr: 'src', type: ResourceType.Binary, tag: hinted ? 'img' : undefined},
      {selector: 'img[data-next]', attr: 'data-next', type: ResourceType.Binary, tag: hinted ? 'img' : undefined}
    ]};
    const lifeCycle = testLifeCycle();
    const observed: string[] = [];
    lifeCycle.processBeforeDownload = [async (resource, _element, parent) => {
      observed.push(resource.url);
      await Promise.resolve();
      if (resource.url.endsWith('/first')) {
        parent!.meta.doc!('body').append('<img data-next="' + parent!.url + '/next">');
      }
      return resource;
    }];
    const pipeline = new PipelineExecutorImpl(lifeCycle, {}, options);
    const first = resHtml('https://example.com/a', '<img src="/a/first">');
    const second = resHtml('https://example.com/b', '<img src="/b/first">');
    await Promise.all([first, second].map(res => processHtml(res, () => {}, options, pipeline)));
    expect(observed.sort()).toEqual([
      'https://example.com/a/first', 'https://example.com/a/next',
      'https://example.com/b/first', 'https://example.com/b/next'
    ]);
  });

  test.each([
    'img[src]', 'img[data-value="a]b"][src]', 'img[src][data-value="x:y"]',
    'img[src][data-value="UPPER" i]', 'img[src]:first', 'body > img[src]',
    'img[camelCase][src]', '[src]', 'img[src],input[src]', 'video source[src]'
  ])('preserves ordinary query semantics for %s', async selector => {
    const res = resHtml('https://example.com/index.html', '');
    const doc = res.meta.doc = load('<img src="/a" data-value="a]b"><img src="/b" data-value="x:y">' +
      '<img src="/c" data-value="upper"><img src="/d" camelCase="yes"><input src="/e">' +
      '<video><source src="/f"/></video><source src="/g"/>',
    {xml: {lowerCaseTags: false, lowerCaseAttributeNames: false}}, false);
    const expected = doc(selector).toArray();
    const observed: unknown[] = [];
    const lifeCycle = testLifeCycle();
    lifeCycle.processBeforeDownload = [resource => resource];
    lifeCycle.linkRedirect = [(url, element) => { observed.push(element![0]); return url; }];
    const options = {...testPipeline.options, sources: [
      {selector, attr: 'src', type: ResourceType.Binary}
    ]};
    const pipeline = new PipelineExecutorImpl(lifeCycle, {}, options);
    await processHtml(res, () => {}, options, pipeline);
    expect(observed).toEqual(expected);
  });

  test.each(['img[', 'input[src="unterminated]'])(
    'reports a later invalid selector %s after preceding hooks have run', async selector => {
      const res = resHtml('https://example.com/index.html', '<img src="/first">');
      const options = {...testPipeline.options, sources: [
        {selector: 'img[src]', attr: 'src', type: ResourceType.Binary},
        {selector, attr: 'src', type: ResourceType.Binary}
      ]};
      const observed: string[] = [];
      const lifeCycle = testLifeCycle();
      lifeCycle.linkRedirect = [url => { observed.push(url); return url; }];
      const pipeline = new PipelineExecutorImpl(lifeCycle, {}, options);
      await expect(processHtml(res, () => {}, options, pipeline)).rejects.toThrow();
      expect(observed).toEqual(['/first']);
    });
});
