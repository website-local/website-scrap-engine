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

/**
 * Get a copy of default life cycle
 */
const testLifeCycle = (): ProcessingLifeCycle => ({
  init: [],
  linkRedirect: [],
  detectResourceType: [],
  createResource,
  processBeforeDownload: [],
  download: [
  ],
  processAfterDownload: [
  ],
  saveToDisk: [],
  dispose: []
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
    let currHtml = '';
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
<style>div {background-image: url("https://cdn.example.com/img.webp")}</style>
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

});
