import {describe, expect, jest, test, beforeEach} from '@jest/globals';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';
import type {
  DownloadResource,
  ExistingResourceContext,
  ExistingResourceFunc,
  ProcessingLifeCycle,
  RequestOptions,
  SaveToDiskFunc
} from '../../src/life-cycle/types.js';
import type {StaticDownloadOptions} from '../../src/options.js';
import type {Stats} from 'node:fs';

const mockExistsSync = jest.fn().mockReturnValue(false);
const mockStatSync = jest.fn();

jest.unstable_mockModule('node:fs', () => {
  const mod = {
    existsSync: mockExistsSync,
    statSync: mockStatSync,
    // needed by other transitive imports
    realpath: jest.fn(),
    promises: {
      writeFile: jest.fn(),
      utimes: jest.fn(),
      stat: jest.fn(),
      access: jest.fn(),
    },
    default: {},
  };
  mod.default = mod;
  return mod;
});

jest.mock('log4js', () => ({
  configure: jest.fn(),
  getLogger: jest.fn().mockReturnValue({
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Dynamic import after mock is set up
const {PipelineExecutorImpl} = await import(
  '../../src/downloader/pipeline-executor-impl.js'
);

const fakeOpt = {
  concurrency: 1,
  encoding: {},
  localRoot: '/test/root',
  maxDepth: 5,
  meta: {}
} as StaticDownloadOptions;

const fakeStat = {
  isFile: () => true,
  size: 1024,
  mtime: new Date('2025-01-15T10:00:00Z'),
} as unknown as Stats;

function makeLifeCycle(
  existingResource?: ExistingResourceFunc
): ProcessingLifeCycle {
  return {
    init: [],
    linkRedirect: [],
    detectResourceType: [],
    createResource,
    processBeforeDownload: [],
    download: [
      (res) => {
        res.body = '<html></html>';
        return res as DownloadResource;
      }
    ],
    processAfterDownload: [],
    saveToDisk: [
      () => {
        return;
      }
    ],
    dispose: [],
    statusChange: [],
    existingResource
  };
}

function makeResource(url?: string): Resource {
  return createResource({
    type: ResourceType.Html,
    depth: 1,
    url: url ?? 'https://example.com/page',
    refUrl: 'https://example.com/',
    localRoot: '/test/root',
    encoding: 'utf8'
  });
}

describe('existingResource: download stage', () => {
  beforeEach(() => {
    mockExistsSync.mockReset().mockReturnValue(false);
    mockStatSync.mockReset();
  });

  test('no callback — proceeds normally', async () => {
    const lc = makeLifeCycle(undefined);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    const result = await pipeline.download(res);
    expect(result).toBeDefined();
    expect(result!.body).toBe('<html></html>');
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  test('file does not exist — proceeds normally', async () => {
    const cb = jest.fn<ExistingResourceFunc>();
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    const result = await pipeline.download(res);
    expect(result).toBeDefined();
    expect(cb).not.toHaveBeenCalled();
  });

  test('skip — sets shouldBeDiscardedFromDownload and returns undefined', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('skip');
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    const result = await pipeline.download(res);
    expect(result).toBeUndefined();
    expect(res.shouldBeDiscardedFromDownload).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    const ctx: ExistingResourceContext = cb.mock.calls[0][0];
    expect(ctx.stage).toBe('download');
    expect(ctx.stat).toBe(fakeStat);
    expect(ctx.res).toBe(res);
  });

  test('overwrite — proceeds to download handlers', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('overwrite');
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    const result = await pipeline.download(res);
    expect(result).toBeDefined();
    expect(result!.body).toBe('<html></html>');
  });

  test('skipSave — treated as overwrite at download stage', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('skipSave');
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    const result = await pipeline.download(res);
    expect(result).toBeDefined();
    expect(result!.body).toBe('<html></html>');
  });

  test('ifModifiedSince — clones requestOptions with header', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('ifModifiedSince');
    let capturedOptions: RequestOptions | undefined;
    const lc = makeLifeCycle(cb);
    lc.download = [
      (res, requestOptions) => {
        capturedOptions = requestOptions;
        res.body = '<html></html>';
        return res as DownloadResource;
      }
    ];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    const origHeaders = {referer: 'https://example.com/'};
    const origOptions: RequestOptions = {headers: origHeaders};

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    await pipeline.download(res, origOptions);

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.headers).toHaveProperty(
      'if-modified-since', fakeStat.mtime.toUTCString());
    // Original should NOT be mutated
    expect(origHeaders).not.toHaveProperty('if-modified-since');
    expect(capturedOptions!.headers).toHaveProperty('referer', 'https://example.com/');
  });

  test('ifModifiedSince — statSync fails for mtime, omits header', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('ifModifiedSince');
    let capturedOptions: RequestOptions | undefined;
    const lc = makeLifeCycle(cb);
    lc.download = [
      (res, requestOptions) => {
        capturedOptions = requestOptions;
        res.body = '<html></html>';
        return res as DownloadResource;
      }
    ];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    let callCount = 0;
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return fakeStat;
      throw new Error('ENOENT');
    });

    await pipeline.download(res, {});

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.headers?.['if-modified-since']).toBeUndefined();
  });

  test('TOCTOU — statSync throws after existsSync, proceeds normally', async () => {
    const cb = jest.fn<ExistingResourceFunc>();
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
    });

    const result = await pipeline.download(res);
    expect(result).toBeDefined();
    expect(cb).not.toHaveBeenCalled();
  });

  test('stat is not a file — proceeds normally', async () => {
    const cb = jest.fn<ExistingResourceFunc>();
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      ...fakeStat,
      isFile: () => false,
    });

    const result = await pipeline.download(res);
    expect(result).toBeDefined();
    expect(cb).not.toHaveBeenCalled();
  });

  test('shouldBeDiscardedFromDownload already set — skips check', async () => {
    const cb = jest.fn<ExistingResourceFunc>();
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();
    res.shouldBeDiscardedFromDownload = true;

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    const result = await pipeline.download(res);
    expect(result).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
    expect(mockExistsSync).not.toHaveBeenCalled();
  });
});

describe('existingResource: saveToDisk stage', () => {
  beforeEach(() => {
    mockExistsSync.mockReset().mockReturnValue(false);
    mockStatSync.mockReset();
  });

  function makeDownloaded(): DownloadResource {
    const res = makeResource();
    res.body = '<html></html>';
    res.meta.headers = {
      'last-modified': 'Wed, 22 Jan 2025 12:00:00 GMT'
    };
    return res as DownloadResource;
  }

  test('no callback — proceeds normally', async () => {
    const lc = makeLifeCycle(undefined);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();

    const result = await pipeline.saveToDisk(res);
    expect(result).toBeUndefined();
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  test('file does not exist — proceeds normally', async () => {
    const cb = jest.fn<ExistingResourceFunc>();
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();

    await pipeline.saveToDisk(res);
    expect(cb).not.toHaveBeenCalled();
  });

  test('skip — returns undefined without saving', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('skip');
    const saveFn = jest.fn<SaveToDiskFunc>().mockReturnValue(undefined);
    const lc = makeLifeCycle(cb);
    lc.saveToDisk = [saveFn];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    const result = await pipeline.saveToDisk(res);
    expect(result).toBeUndefined();
    expect(saveFn).not.toHaveBeenCalled();
  });

  test('skipSave — alias for skip at save stage', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('skipSave');
    const saveFn = jest.fn<SaveToDiskFunc>().mockReturnValue(undefined);
    const lc = makeLifeCycle(cb);
    lc.saveToDisk = [saveFn];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    const result = await pipeline.saveToDisk(res);
    expect(result).toBeUndefined();
    expect(saveFn).not.toHaveBeenCalled();
  });

  test('overwrite — proceeds to save handlers', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('overwrite');
    const saveFn = jest.fn<SaveToDiskFunc>().mockReturnValue(undefined);
    const lc = makeLifeCycle(cb);
    lc.saveToDisk = [saveFn];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    await pipeline.saveToDisk(res);
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  test('ifModifiedSince — skips save when local is newer', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('ifModifiedSince');
    const saveFn = jest.fn<SaveToDiskFunc>().mockReturnValue(undefined);
    const lc = makeLifeCycle(cb);
    lc.saveToDisk = [saveFn];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();
    const newerStat = {
      isFile: () => true,
      size: 1024,
      mtime: new Date('2025-01-29T00:00:00Z'),
    } as unknown as Stats;

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(newerStat);

    const result = await pipeline.saveToDisk(res);
    expect(result).toBeUndefined();
    expect(saveFn).not.toHaveBeenCalled();
  });

  test('ifModifiedSince — saves when remote is newer', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('ifModifiedSince');
    const saveFn = jest.fn<SaveToDiskFunc>().mockReturnValue(undefined);
    const lc = makeLifeCycle(cb);
    lc.saveToDisk = [saveFn];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();
    const olderStat = {
      isFile: () => true,
      size: 1024,
      mtime: new Date('2025-01-01T00:00:00Z'),
    } as unknown as Stats;

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(olderStat);

    await pipeline.saveToDisk(res);
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  test('ifModifiedSince — saves when no last-modified header', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('ifModifiedSince');
    const saveFn = jest.fn<SaveToDiskFunc>().mockReturnValue(undefined);
    const lc = makeLifeCycle(cb);
    lc.saveToDisk = [saveFn];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();
    delete res.meta.headers!['last-modified'];

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    await pipeline.saveToDisk(res);
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  test('ifModifiedSince — skips save when timestamps equal', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('ifModifiedSince');
    const saveFn = jest.fn<SaveToDiskFunc>().mockReturnValue(undefined);
    const lc = makeLifeCycle(cb);
    lc.saveToDisk = [saveFn];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();
    res.meta.headers = {
      'last-modified': 'Wed, 15 Jan 2025 10:00:00 GMT'
    };

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    const result = await pipeline.saveToDisk(res);
    expect(result).toBeUndefined();
    expect(saveFn).not.toHaveBeenCalled();
  });

  test('ifModifiedSince — TOCTOU during save-stage stat, proceeds with save', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('ifModifiedSince');
    const saveFn = jest.fn<SaveToDiskFunc>().mockReturnValue(undefined);
    const lc = makeLifeCycle(cb);
    lc.saveToDisk = [saveFn];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();

    let statCallCount = 0;
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockImplementation(() => {
      statCallCount++;
      if (statCallCount <= 1) return fakeStat;
      throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
    });

    await pipeline.saveToDisk(res);
    expect(saveFn).toHaveBeenCalledTimes(1);
  });
});

describe('existingResource: context object', () => {
  beforeEach(() => {
    mockExistsSync.mockReset().mockReturnValue(false);
    mockStatSync.mockReset();
  });

  test('download stage passes correct context', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('overwrite');
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource('https://example.com/page');

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    await pipeline.download(res);

    expect(cb).toHaveBeenCalledTimes(1);
    const ctx: ExistingResourceContext = cb.mock.calls[0][0];
    expect(ctx.stage).toBe('download');
    expect(ctx.localPath).toContain('/test/root');
    expect(ctx.localPath).toContain('example.com');
    expect(ctx.stat).toBe(fakeStat);
    expect(ctx.res).toBe(res);
    expect(ctx.options).toBe(fakeOpt);
  });

  test('saveToDisk stage passes correct context', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('overwrite');
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource('https://example.com/page');
    res.body = '<html></html>';
    res.meta.headers = {'last-modified': 'Wed, 22 Jan 2025 12:00:00 GMT'};

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(fakeStat);

    await pipeline.saveToDisk(res as DownloadResource);

    expect(cb).toHaveBeenCalledTimes(1);
    const ctx: ExistingResourceContext = cb.mock.calls[0][0];
    expect(ctx.stage).toBe('saveToDisk');
    expect(ctx.localPath).toContain('/test/root');
    expect(ctx.localPath).toContain('example.com');
    expect(ctx.stat).toBe(fakeStat);
    expect(ctx.res).toBe(res);
    expect(ctx.options).toBe(fakeOpt);
  });
});

describe('convenience callbacks', () => {
  test('skipExisting returns skip at download, overwrite at save', async () => {
    const {skipExisting} = await import('../../src/life-cycle/adapters.js');
    const fn = skipExisting();
    expect(fn({stage: 'download'} as ExistingResourceContext)).toBe('skip');
    expect(fn({stage: 'saveToDisk'} as ExistingResourceContext)).toBe('overwrite');
  });

  test('preferNewerRemote returns ifModifiedSince for both stages', async () => {
    const {preferNewerRemote} = await import('../../src/life-cycle/adapters.js');
    const fn = preferNewerRemote();
    expect(fn({stage: 'download'} as ExistingResourceContext)).toBe('ifModifiedSince');
    expect(fn({stage: 'saveToDisk'} as ExistingResourceContext)).toBe('ifModifiedSince');
  });

  test('alwaysOverwrite returns overwrite for both stages', async () => {
    const {alwaysOverwrite} = await import('../../src/life-cycle/adapters.js');
    const fn = alwaysOverwrite();
    expect(fn({stage: 'download'} as ExistingResourceContext)).toBe('overwrite');
    expect(fn({stage: 'saveToDisk'} as ExistingResourceContext)).toBe('overwrite');
  });
});
