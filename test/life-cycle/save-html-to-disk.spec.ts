import {describe, expect, jest, test} from '@jest/globals';
import * as fs from 'node:fs';
import {load} from 'cheerio';
// noinspection ES6PreferShortImport
import {saveHtmlToDisk} from '../../src/life-cycle/save-html-to-disk.js';
import {join} from 'node:path';
import {
  fakeOpt,
  fakePipeline,
  mockFs,
  mockModules,
  resHtml as res
} from './save-mock-fs.js';
import {ResourceType} from '../../src/resource.js';

mockModules();

describe('save-html-to-disk', function () {
  test('skip non html', async () => {
    jest.spyOn(fs.promises, 'writeFile').mockClear();
    expect(jest.isMockFunction(fs.promises.writeFile)).toBe(true);
    const downloadResource = res('http://example.com', 'body');
    downloadResource.type = ResourceType.Binary;
    const saved = await saveHtmlToDisk(downloadResource, fakeOpt, fakePipeline);
    expect(saved).toBe(downloadResource);
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
  });

  test('save regular html', async () => {
    const {fakeFs} = mockFs();
    const saved = await saveHtmlToDisk(
      res('http://example.com', 'body'), fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: 'body'
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
  });

  // https://github.com/website-local/website-scrap-engine/issues/174
  test('save regular html with last-modified header', async () => {
    const {fakeFs, fakeFsStats} = mockFs();
    const resource = res('http://example.com', 'body');
    resource.meta.headers = {
      'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
    };
    const saved = await saveHtmlToDisk(resource, Object.assign({
      preferRemoteLastModifiedTime: true
    }, fakeOpt), fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: 'body'
    });
    expect(fakeFsStats).toStrictEqual({
      [join('root', 'example.com', 'index.html') + '::atime']: 1445412480000,
      [join('root', 'example.com', 'index.html') + '::mtime']: 1445412480000,
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.promises.utimes).toHaveBeenCalledTimes(1);
  });

  // https://github.com/website-local/website-scrap-engine/issues/174
  test('save regular html with disabled last-modified header', async () => {
    const {fakeFs, fakeFsStats} = mockFs();
    const resource = res('http://example.com', 'body');
    resource.meta.headers = {
      'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
    };
    const saved = await saveHtmlToDisk(resource, fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: 'body'
    });
    expect(fakeFsStats).toStrictEqual({});
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.promises.utimes).not.toHaveBeenCalled();
  });

  test('save processed html', async () => {
    const {fakeFs} = mockFs();
    const downloadResource = res('http://example.com', 'body');
    const html = '<html lang="en"><head><title></title></head><body></body></html>';
    downloadResource.meta.doc = load(html);
    const saved = await saveHtmlToDisk(downloadResource, fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: html
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
  });

  test('save processed html with non-ascii chars', async () => {
    const {fakeFs} = mockFs();
    const downloadResource = res('http://example.com', 'body');
    const html = '<html lang="en"><head><title>啊</title></head><body></body></html>';
    downloadResource.meta.doc = load(html);
    const saved = await saveHtmlToDisk(downloadResource, fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: html
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
  });

  test('save processed html custom serialize options', async () => {
    const {fakeFs} = mockFs();
    const downloadResource = res('http://example.com', 'body');
    const html = '<html lang="en"><head><title>啊</title></head><body></body></html>';
    downloadResource.meta.doc = load(html);
    const opt = Object.assign({}, fakeOpt);
    opt.cheerioSerialize = {
      // the new mode of  _useHtmlParser2: true,
      xml: {
        xmlMode: false,
        decodeEntities: true
      },
    };
    const saved = await saveHtmlToDisk(downloadResource, opt, fakePipeline);
    expect(saved).toBeUndefined();
    const encodedHtml =
      '<html lang="en"><head><title>&#x554a;</title></head><body></body></html>';
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: encodedHtml
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
  });

  test('save redirected html', async () => {
    const {fakeFs} = mockFs();
    const downloadResource = res('http://example.com', 'body');
    downloadResource.redirectedUrl = 'http://example.com/en-US/';
    const html = '<html lang="en"><head><title></title></head><body></body></html>';
    downloadResource.meta.doc = load(html);
    const saved = await saveHtmlToDisk(downloadResource, fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: `<html lang="en">
<head>
<meta charset="utf8">
<meta http-equiv="refresh" content="0; url=en-US/index.html">
<script>location.replace('en-US/index.html' + location.hash);</script>
<title>Redirecting</title>
</head>
</html>`,
      [join('root', 'example.com', 'en-US', 'index.html')]: html
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(2);
  });

  test('save redirected html with redirectedSavePath', async () => {
    const {fakeFs} = mockFs();
    const downloadResource = res('http://example.com/', 'body');
    downloadResource.redirectedSavePath = join('example.com', 'zh-CN', 'demo1.html');
    downloadResource.redirectedUrl = 'http://example.com/zh-CN/';
    const saved = await saveHtmlToDisk(downloadResource, fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: `<html lang="en">
<head>
<meta charset="utf8">
<meta http-equiv="refresh" content="0; url=zh-CN/demo1.html">
<script>location.replace('zh-CN/demo1.html' + location.hash);</script>
<title>Redirecting</title>
</head>
</html>`,
      [join('root', 'example.com', 'zh-CN', 'demo1.html')]: 'body'
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(2);
  });

  test('save html with same redirectedSavePath and savePath', async () => {
    const {fakeFs} = mockFs();
    const downloadResource = res('http://example.com/', 'body');
    downloadResource.redirectedSavePath = join('example.com', 'zh-CN', 'demo1.html');
    downloadResource.redirectedUrl = 'http://example.com/zh-CN/';
    downloadResource.redirectedSavePath = downloadResource.savePath;
    const saved = await saveHtmlToDisk(downloadResource, fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: 'body',
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
  });
});
