import {describe, expect, test} from '@jest/globals';
import * as fs from 'fs';
// noinspection ES6PreferShortImport
import {
  saveResourceToDisk
} from '../../src/life-cycle/save-resource-to-disk.js';
import {join} from 'path';
import {
  fakeOpt,
  fakePipeline,
  mockFs,
  mockModules,
  res
} from './save-mock-fs.js';

mockModules();

describe('save-resource-to-disk', function () {
  test('save regular resource', async () => {
    const {fakeFs} = mockFs();
    const saved = await saveResourceToDisk(
      res('http://example.com/test.bin', 'body'), fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'test.bin')]: 'body'
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
  });

  // https://github.com/website-local/website-scrap-engine/issues/174
  test('save resource with last-modified header', async () => {
    const {fakeFs, fakeFsStats} = mockFs();
    const resource = res('http://example.com/test.bin', 'body');
    resource.meta.headers = {
      'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
    };
    const saved = await saveResourceToDisk(resource, Object.assign({
      preferRemoteLastModifiedTime: true
    }, fakeOpt), fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'test.bin')]: 'body'
    });
    expect(fakeFsStats).toStrictEqual({
      [join('root', 'example.com', 'test.bin') + '::atime']: 1445412480000,
      [join('root', 'example.com', 'test.bin') + '::mtime']: 1445412480000,
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.promises.utimes).toHaveBeenCalledTimes(1);
  });

  // https://github.com/website-local/website-scrap-engine/issues/174
  test('save resource with disabled last-modified header', async () => {
    const {fakeFs, fakeFsStats} = mockFs();
    const resource = res('http://example.com/test.bin', 'body');
    resource.meta.headers = {
      'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
    };
    const saved = await saveResourceToDisk(resource, fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'test.bin')]: 'body'
    });
    expect(fakeFsStats).toStrictEqual({});
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.promises.utimes).not.toHaveBeenCalled();
  });

  test('save redirected resource', async () => {
    const {fakeFs} = mockFs();
    const downloadResource = res('http://example.com/demo.bin', 'body');
    downloadResource.redirectedUrl = 'http://example.com/en-US/demo.bin';
    const saved = await saveResourceToDisk(downloadResource, fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'demo.bin')]: 'body',
      [join('root', 'example.com', 'en-US', 'demo.bin')]: 'body'
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(2);
  });

  // https://github.com/website-local/website-scrap-engine/issues/174
  test('save redirected resource with mtime', async () => {
    const {fakeFs, fakeFsStats} = mockFs();
    const downloadResource = res('http://example.com/demo.bin', 'body');
    downloadResource.redirectedUrl = 'http://example.com/en-US/demo.bin';
    downloadResource.meta.headers = {
      'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
    };
    const saved = await saveResourceToDisk(downloadResource, Object.assign({
      preferRemoteLastModifiedTime: true
    }, fakeOpt), fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'demo.bin')]: 'body',
      [join('root', 'example.com', 'en-US', 'demo.bin')]: 'body'
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(2);
    expect(fakeFsStats).toStrictEqual({
      [join('root', 'example.com', 'demo.bin') + '::atime']: 1445412480000,
      [join('root', 'example.com', 'demo.bin') + '::mtime']: 1445412480000,
      [join('root', 'example.com', 'en-US', 'demo.bin') + '::atime']: 1445412480000,
      [join('root', 'example.com', 'en-US', 'demo.bin') + '::mtime']: 1445412480000,
    });
    expect(fs.promises.utimes).toHaveBeenCalledTimes(2);
  });

  test('save redirected resource with redirectedSavePath', async () => {
    const {fakeFs} = mockFs();
    const downloadResource = res('http://example.com/demo.bin', 'body');
    downloadResource.redirectedSavePath = join('example.com', 'en-US', 'demo1.bin');
    downloadResource.redirectedUrl = 'http://example.com/en-US/demo.bin';
    const saved = await saveResourceToDisk(downloadResource, fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'demo.bin')]: 'body',
      [join('root', 'example.com', 'en-US', 'demo1.bin')]: 'body'
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(2);
  });

  // https://github.com/website-local/website-scrap-engine/issues/174
  test('save redirected resource ' +
    'with redirectedSavePath and mtime', async () => {
    const {fakeFs, fakeFsStats} = mockFs();
    const downloadResource = res('http://example.com/demo.bin', 'body');
    downloadResource.redirectedSavePath = join('example.com', 'en-US', 'demo1.bin');
    downloadResource.redirectedUrl = 'http://example.com/en-US/demo.bin';
    downloadResource.meta.headers = {
      'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
    };
    const saved = await saveResourceToDisk(downloadResource, Object.assign({
      preferRemoteLastModifiedTime: true
    }, fakeOpt), fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'demo.bin')]: 'body',
      [join('root', 'example.com', 'en-US', 'demo1.bin')]: 'body'
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(2);
    expect(fakeFsStats).toStrictEqual({
      [join('root', 'example.com', 'demo.bin') + '::atime']: 1445412480000,
      [join('root', 'example.com', 'demo.bin') + '::mtime']: 1445412480000,
      [join('root', 'example.com', 'en-US', 'demo1.bin') + '::atime']: 1445412480000,
      [join('root', 'example.com', 'en-US', 'demo1.bin') + '::mtime']: 1445412480000,
    });
    expect(fs.promises.utimes).toHaveBeenCalledTimes(2);
  });

  test('save resource with same redirectedSavePath and savePath', async () => {
    const {fakeFs} = mockFs();
    const downloadResource = res('http://example.com/demo.bin', 'body');
    downloadResource.redirectedSavePath = downloadResource.savePath;
    downloadResource.redirectedUrl = 'http://example.com/en-US/demo.bin';
    const saved = await saveResourceToDisk(downloadResource, fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'demo.bin')]: 'body',
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
  });

  // https://github.com/website-local/website-scrap-engine/issues/174
  test('save resource with mtime' +
    'with same redirectedSavePath and savePath', async () => {
    const {fakeFs, fakeFsStats} = mockFs();
    const downloadResource = res('http://example.com/demo.bin', 'body');
    downloadResource.redirectedSavePath = downloadResource.savePath;
    downloadResource.redirectedUrl = 'http://example.com/en-US/demo.bin';
    downloadResource.meta.headers = {
      'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
    };
    const saved = await saveResourceToDisk(downloadResource, Object.assign({
      preferRemoteLastModifiedTime: true
    }, fakeOpt), fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'demo.bin')]: 'body',
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
    expect(fakeFsStats).toStrictEqual({
      [join('root', 'example.com', 'demo.bin') + '::atime']: 1445412480000,
      [join('root', 'example.com', 'demo.bin') + '::mtime']: 1445412480000,
    });
    expect(fs.promises.utimes).toHaveBeenCalledTimes(1);
  });
});
