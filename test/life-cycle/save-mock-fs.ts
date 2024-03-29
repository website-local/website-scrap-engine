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
// noinspection ES6PreferShortImport
import type {PipelineExecutor} from '../../src/life-cycle/pipeline-executor';
import fs from 'fs';
import {toString} from '../../src/util';

export const fakeOpt = {
  concurrency: 0,
  encoding: {},
  localRoot: 'root',
  maxDepth: 0,
  meta: {}
} as StaticDownloadOptions;

export const fakePipeline = {
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

export const res = (
  url: string,
  body: ResourceBody,
  refUrl?: string,
  refSavePath?: string
): DownloadResource => {
  const resource = fakePipeline.createResource(
    ResourceType.Binary, 1, url, refUrl ?? url,
    undefined, undefined, refSavePath
  ) as Resource;
  resource.body = body;
  return resource as DownloadResource;
};

export const resHtml = (
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

export function mockFs(): {
  fakeFs: Record<string, string>,
  fakeFsStats: Record<string, number>
  } {
  const fakeFs: Record<string, string> = {};
  jest.spyOn(fs.promises, 'writeFile').mockClear()
    .mockImplementation((path, data) => {
      if (typeof data === 'string' ||
        Buffer.isBuffer(data) ||
        data instanceof ArrayBuffer ||
        data instanceof Uint8Array) {
        fakeFs[path.toString()] = toString(data, 'utf8');
        return Promise.resolve();
      }
      return Promise.reject(
        'mock fs writeFile with type not supported yet');
    });
  const fakeFsStats: Record<string, number> = {};
  jest.spyOn(fs.promises, 'utimes').mockClear()
    .mockImplementation((path, atime, mtime) => {
      fakeFsStats[path + '::atime'] = atime as number;
      fakeFsStats[path + '::mtime'] = mtime as number;
      return Promise.resolve();
    });
  expect(jest.isMockFunction(fs.promises.writeFile)).toBe(true);
  expect(jest.isMockFunction(fs.promises.utimes)).toBe(true);
  return {fakeFs, fakeFsStats};
}

export function mockModules(): void {
  jest.mock('fs', () => ({
    // skip the mkdir process
    existsSync: jest.fn().mockReturnValue(true),
    // make log4js and fs-extra happy in mocked env
    realpath: jest.fn(),
    promises: {
      writeFile: jest.fn(),
      utimes: jest.fn()
    }
  }));
  jest.mock('mkdirp');
  jest.mock('log4js');
}
