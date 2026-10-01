import {beforeEach, describe, expect, jest, test} from '@jest/globals';
import type {Resource} from '../../src/resource.js';
import {createResource, ResourceType} from '../../src/resource.js';
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
import {constants} from 'node:fs';

const mockStat = jest.fn<(path: string) => Promise<Stats>>();

jest.unstable_mockModule('node:fs', () => {
  const mod = {
    constants,
    // needed by other transitive imports
    realpath: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    lstat: jest.fn(),
    createReadStream: jest.fn(),
    createWriteStream: jest.fn(),
    promises: {
      writeFile: jest.fn(),
      utimes: jest.fn(),
      stat: mockStat,
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
    generateSavePath: [],
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
    mockStat.mockReset().mockRejectedValue(
      Object.assign(new Error('ENOENT'), {code: 'ENOENT'}));
  });

  test('no callback — proceeds normally', async () => {
    const lc = makeLifeCycle(undefined);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    const result = await pipeline.download(res);
    expect(result).toBeDefined();
    expect(result!.body).toBe('<html></html>');
    expect(mockStat).not.toHaveBeenCalled();
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

    mockStat.mockResolvedValue(fakeStat);

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

    mockStat.mockResolvedValue(fakeStat);

    const result = await pipeline.download(res);
    expect(result).toBeDefined();
    expect(result!.body).toBe('<html></html>');
  });

  test('skipSave — treated as overwrite at download stage', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('skipSave');
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    mockStat.mockResolvedValue(fakeStat);

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

    mockStat.mockResolvedValue(fakeStat);

    await pipeline.download(res, origOptions);

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.headers).toHaveProperty(
      'if-modified-since', fakeStat.mtime.toUTCString());
    expect(mockStat).toHaveBeenCalledTimes(1);
    // Original should NOT be mutated
    expect(origHeaders).not.toHaveProperty('if-modified-since');
    expect(capturedOptions!.headers).toHaveProperty('referer', 'https://example.com/');
  });

  test('ifModifiedSince — unavailable metadata omits the header', async () => {
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

    mockStat.mockRejectedValue(
      Object.assign(new Error('ENOENT'), {code: 'ENOENT'}));

    await pipeline.download(res, {});

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.headers?.['if-modified-since']).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
  });

  test('metadata lookup fails — proceeds normally', async () => {
    const cb = jest.fn<ExistingResourceFunc>();
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    mockStat.mockRejectedValue(
      Object.assign(new Error('EACCES'), {code: 'EACCES'}));

    const result = await pipeline.download(res);
    expect(result).toBeDefined();
    expect(cb).not.toHaveBeenCalled();
  });

  test('stat is not a file — proceeds normally', async () => {
    const cb = jest.fn<ExistingResourceFunc>();
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    mockStat.mockResolvedValue({
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

    mockStat.mockResolvedValue(fakeStat);

    const result = await pipeline.download(res);
    expect(result).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
    expect(mockStat).not.toHaveBeenCalled();
  });

  test('waits for metadata before deciding whether to download', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('skip');
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();
    let resolveStat!: (stat: Stats) => void;
    mockStat.mockReturnValue(new Promise(resolve => {
      resolveStat = resolve;
    }));

    const pending = pipeline.download(res);
    expect(mockStat).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled();
    expect(res.body).toBeUndefined();

    resolveStat(fakeStat);
    expect(await pending).toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(res.body).toBeUndefined();
    expect(res.shouldBeDiscardedFromDownload).toBe(true);
  });
});

describe('existingResource: saveToDisk stage', () => {
  beforeEach(() => {
    mockStat.mockReset().mockRejectedValue(
      Object.assign(new Error('ENOENT'), {code: 'ENOENT'}));
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
    expect(mockStat).not.toHaveBeenCalled();
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

    mockStat.mockResolvedValue(fakeStat);

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

    mockStat.mockResolvedValue(fakeStat);

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

    mockStat.mockResolvedValue(fakeStat);

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

    mockStat.mockResolvedValue(newerStat);

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

    mockStat.mockResolvedValue(olderStat);

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

    mockStat.mockResolvedValue(fakeStat);

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

    mockStat.mockResolvedValue(fakeStat);

    const result = await pipeline.saveToDisk(res);
    expect(result).toBeUndefined();
    expect(saveFn).not.toHaveBeenCalled();
    expect(mockStat).toHaveBeenCalledTimes(1);
  });

  test('ifModifiedSince — saves a file deleted during download', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('ifModifiedSince');
    const saveFn = jest.fn<SaveToDiskFunc>().mockReturnValue(undefined);
    const lc = makeLifeCycle(cb);
    lc.saveToDisk = [saveFn];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();

    res.meta.headers = {'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT'};
    mockStat.mockResolvedValueOnce(fakeStat).mockRejectedValueOnce(
      Object.assign(new Error('ENOENT'), {code: 'ENOENT'}));

    await pipeline.download(res);
    await pipeline.saveToDisk(res);
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(mockStat).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('ifModifiedSince — preserves a file updated during download', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('ifModifiedSince');
    const saveFn = jest.fn<SaveToDiskFunc>().mockReturnValue(undefined);
    const lc = makeLifeCycle(cb);
    lc.saveToDisk = [saveFn];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeDownloaded();
    const updatedStat = {...fakeStat, mtime: new Date('2025-01-29T00:00:00Z')};
    mockStat.mockResolvedValueOnce(fakeStat).mockResolvedValueOnce(updatedStat);

    await pipeline.download(res);
    await pipeline.saveToDisk(res);

    expect(saveFn).not.toHaveBeenCalled();
    expect(mockStat).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls.map(([ctx]) => ctx.stage))
      .toEqual(['download', 'saveToDisk']);
    expect(cb.mock.calls[1][0].stat).toBe(updatedStat);
  });
});

describe('existingResource: context object', () => {
  beforeEach(() => {
    mockStat.mockReset().mockRejectedValue(
      Object.assign(new Error('ENOENT'), {code: 'ENOENT'}));
  });

  test('download stage passes correct context', async () => {
    const cb = jest.fn<ExistingResourceFunc>().mockReturnValue('overwrite');
    const lc = makeLifeCycle(cb);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource('https://example.com/page');

    mockStat.mockResolvedValue(fakeStat);

    await pipeline.download(res);

    expect(cb).toHaveBeenCalledTimes(1);
    const ctx: ExistingResourceContext = cb.mock.calls[0][0];
    expect(ctx.stage).toBe('download');
    expect(ctx.localPath).toMatch(/[\\/]test[\\/]root/);
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

    mockStat.mockResolvedValue(fakeStat);

    await pipeline.saveToDisk(res as DownloadResource);

    expect(cb).toHaveBeenCalledTimes(1);
    const ctx: ExistingResourceContext = cb.mock.calls[0][0];
    expect(ctx.stage).toBe('saveToDisk');
    expect(ctx.localPath).toMatch(/[\\/]test[\\/]root/);
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
