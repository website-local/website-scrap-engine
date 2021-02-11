import * as fs from 'fs';
import {toString} from '../../src/util';
// noinspection ES6PreferShortImport
import {saveResourceToDisk} from '../../src/life-cycle/save-resource-to-disk';
import {join} from 'path';
import {fakeOpt, fakePipeline, res} from './save-mock-fs';

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

describe('save-resource-to-disk', function () {
  test('save regular resource', async () => {
    const fakeFs: Record<string, string> = {};
    jest.spyOn(fs.promises, 'writeFile').mockClear()
      .mockImplementation((path, data) => {
        fakeFs[path.toString()] = toString(data, 'utf8');
        return Promise.resolve();
      });
    expect(jest.isMockFunction(fs.promises.writeFile)).toBe(true);
    const saved = await saveResourceToDisk(
      res('http://example.com/test.bin', 'body'), fakeOpt, fakePipeline);
    expect(saved).toBeUndefined();
    expect(fakeFs).toStrictEqual({
      [join('root', 'example.com', 'test.bin')]: 'body'
    });
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
  });

  test('save redirected resource', async () => {
    const fakeFs: Record<string, string> = {};
    jest.spyOn(fs.promises, 'writeFile').mockClear()
      .mockImplementation((path, data) => {
        fakeFs[path.toString()] = toString(data, 'utf8');
        return Promise.resolve();
      });
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
    const fakeFs: Record<string, string> = {};
    jest.spyOn(fs.promises, 'writeFile').mockClear()
      .mockImplementation((path, data) => {
        fakeFs[path.toString()] = toString(data, 'utf8');
        return Promise.resolve();
      });
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
    const fakeFs: Record<string, string> = {};
    jest.spyOn(fs.promises, 'writeFile').mockClear()
      .mockImplementation((path, data) => {
        fakeFs[path.toString()] = toString(data, 'utf8');
        return Promise.resolve();
      });
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
