import cheerio from 'cheerio';
import * as fs from 'fs';
import {toString} from '../../src/util';
// noinspection ES6PreferShortImport
import type {PipelineExecutor} from '../../src/life-cycle/pipeline-executor';
// noinspection ES6PreferShortImport
import {saveHtmlToDisk} from '../../src/life-cycle/save-html-to-disk';
import {
  createResource,
  CreateResourceArgument,
  Resource,
  ResourceBody,
  ResourceEncoding,
  ResourceType
} from '../../src/resource';
import type {DownloadResource} from '../../src/life-cycle/types';
import type {StaticDownloadOptions} from '../../src/options';
import {join} from 'path';

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

const fakeOpt = {
  concurrency: 0,
  encoding: {},
  localRoot: 'root',
  maxDepth: 0,
  meta: {}
} as StaticDownloadOptions;

const fakePipeline = {
  createResource(
    type: ResourceType,
    depth: number,
    url: string,
    refUrl: string,
    localRoot?: string,
    encoding?: ResourceEncoding,
    refSavePath?: string,
    refType?: ResourceType
  ): Resource {
    const arg: CreateResourceArgument = {
      type,
      depth,
      url,
      refUrl,
      refSavePath,
      refType,
      localRoot: localRoot ?? 'root',
      encoding: encoding ?? 'utf8',
    };
    return createResource(arg);
  }

} as PipelineExecutor;

const res = (
  url: string,
  body: ResourceBody,
  refUrl?: string,
  refSavePath?: string
): DownloadResource => {
  const resource = fakePipeline.createResource(
    ResourceType.Html, 1, url, refUrl ?? url,
    undefined, undefined, refSavePath
  ) as Resource;
  resource.body = body;
  return resource as DownloadResource;
};

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
});
