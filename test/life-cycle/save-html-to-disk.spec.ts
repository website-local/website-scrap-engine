import cheerio from 'cheerio';
import * as fs from 'fs';
import {toString} from '../../src/util';
// noinspection ES6PreferShortImport
import {saveHtmlToDisk} from '../../src/life-cycle/save-html-to-disk';
import {fakeOpt, fakePipeline, resHtml as res} from './save-mock-fs';
import {join} from 'path';
import {ResourceType} from '../../src/resource';

jest.mock('fs', () => ({
  // skip the mkdir process
  existsSync: jest.fn().mockReturnValue(true),
  // make log4js and fs-extra happy in mocked env
  realpath: jest.fn(),
  promises: {
    writeFile: jest.fn()
  }
}));
jest.mock('mkdirp');
jest.mock('log4js');

describe('save-html-to-disk', function () {
  test('skip non html', async () => {
    expect(jest.isMockFunction(fs.promises.writeFile)).toBe(true);
    jest.spyOn(fs.promises, 'writeFile').mockClear();
    const downloadResource = res('http://example.com', 'body');
    downloadResource.type = ResourceType.Binary;
    const saved = await saveHtmlToDisk(downloadResource, fakeOpt, fakePipeline);
    expect(saved).toBe(downloadResource);
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
  });

  test('save regular html', async () => {
    const fakeFs: Record<string, string> = {};
    expect(jest.isMockFunction(fs.promises.writeFile)).toBe(true);
    jest.spyOn(fs.promises, 'writeFile').mockClear()
      .mockImplementation((path, data) => {
        fakeFs[path.toString()] = toString(data, 'utf8');
        return Promise.resolve();
      });
    const saved = await saveHtmlToDisk(
      res('http://example.com', 'body'), fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: 'body'
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
  });

  test('save processed html', async () => {
    const fakeFs: Record<string, string> = {};
    jest.spyOn(fs.promises, 'writeFile').mockClear()
      .mockImplementation((path, data) => {
        fakeFs[path.toString()] = toString(data, 'utf8');
        return Promise.resolve();
      });
    const downloadResource = res('http://example.com', 'body');
    const html = '<html lang="en"><head><title></title></head><body></body></html>';
    downloadResource.meta.doc = cheerio.load(html);
    const saved = await saveHtmlToDisk(downloadResource, fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: html
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
  });

  test('save processed html custom serialize options', async () => {
    const fakeFs: Record<string, string> = {};
    jest.spyOn(fs.promises, 'writeFile').mockClear()
      .mockImplementation((path, data) => {
        fakeFs[path.toString()] = toString(data, 'utf8');
        return Promise.resolve();
      });
    const downloadResource = res('http://example.com', 'body');
    const html = '<html lang="en"><head><title>啊</title></head><body></body></html>';
    downloadResource.meta.doc = cheerio.load(html);
    const opt = Object.assign({}, fakeOpt);
    opt.cheerioSerialize = {
      _useHtmlParser2: true,
      decodeEntities: true
    };
    const saved = await saveHtmlToDisk(downloadResource, opt, fakePipeline);
    expect(saved).toBeUndefined();
    const encodedHtml =
      '<html lang="en"><head><title>&#x554A;</title></head><body></body></html>';
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'index.html')]: encodedHtml
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
  });

  test('save redirected html', async () => {
    const fakeFs: Record<string, string> = {};
    jest.spyOn(fs.promises, 'writeFile').mockClear()
      .mockImplementation((path, data) => {
        fakeFs[path.toString()] = toString(data, 'utf8');
        return Promise.resolve();
      });
    const downloadResource = res('http://example.com', 'body');
    downloadResource.redirectedUrl = 'http://example.com/en-US/';
    const html = '<html lang="en"><head><title></title></head><body></body></html>';
    downloadResource.meta.doc = cheerio.load(html);
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
    const fakeFs: Record<string, string> = {};
    jest.spyOn(fs.promises, 'writeFile').mockClear()
      .mockImplementation((path, data) => {
        fakeFs[path.toString()] = toString(data, 'utf8');
        return Promise.resolve();
      });
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
    const fakeFs: Record<string, string> = {};
    jest.spyOn(fs.promises, 'writeFile').mockClear()
      .mockImplementation((path, data) => {
        fakeFs[path.toString()] = toString(data, 'utf8');
        return Promise.resolve();
      });
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
