import * as fs from 'fs';
// noinspection ES6PreferShortImport
import {saveResourceToDisk} from '../../src/life-cycle/save-resource-to-disk';
import {join} from 'path';
import {fakeOpt, fakePipeline, mockFs, mockModules, res} from './save-mock-fs';

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
});
