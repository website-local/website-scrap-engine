import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {promises as fs} from 'node:fs';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';
import {
  LocalUrlMountNotFoundError,
  localUrlMounts
} from '../../src/life-cycle/local-url-mount.js';
import type {LocalUrlMountMeta} from '../../src/life-cycle/local-url-mount.js';
import type {
  DownloadResource,
  DownloadResourceFunc,
  ProcessingLifeCycle
} from '../../src/life-cycle/types.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import type {StaticDownloadOptions} from '../../src/options.js';

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

let tmpRoot: string;
let sourceRoot: string;
let destinationRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'wse-local-url-mount-'));
  sourceRoot = path.join(tmpRoot, 'source');
  destinationRoot = path.join(tmpRoot, 'dest');
  await fs.mkdir(sourceRoot, {recursive: true});
  await fs.mkdir(destinationRoot, {recursive: true});
});

afterEach(async () => {
  await fs.rm(tmpRoot, {recursive: true, force: true});
});

const fakeOpt = (): StaticDownloadOptions => ({
  concurrency: 1,
  deduplicateStripSearch: true,
  encoding: {},
  localRoot: destinationRoot,
  maxDepth: 5,
  meta: {}
} as StaticDownloadOptions);

function makeLifeCycle(download: DownloadResourceFunc[]): ProcessingLifeCycle {
  return {
    init: [],
    linkRedirect: [],
    detectResourceType: [],
    generateSavePath: [],
    createResource,
    processBeforeDownload: [],
    download,
    processAfterDownload: [],
    saveToDisk: [],
    dispose: [],
    statusChange: []
  };
}

function makePipeline(
  download: DownloadResourceFunc[]
): PipelineExecutorImpl {
  const opt = fakeOpt();
  return new PipelineExecutorImpl(makeLifeCycle(download), {}, opt);
}

function makeResource(
  url: string,
  type: ResourceType = ResourceType.Html
): Resource {
  return createResource({
    type,
    depth: 1,
    url,
    refUrl: 'https://example.com/',
    localRoot: destinationRoot,
    encoding: type === ResourceType.Binary ||
      type === ResourceType.StreamingBinary ? null : 'utf8'
  });
}

async function writeFile(relativePath: string, data: string): Promise<void> {
  const filePath = path.join(sourceRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, data);
}

describe('localUrlMounts', () => {
  test('reads a matched HTTP URL from the mounted directory', async () => {
    await writeFile(path.join('a', 'page.html'), '<html>mounted</html>');
    const pipeline = makePipeline([
      localUrlMounts([
        {root: sourceRoot, urlPrefix: 'https://example.com/xxx/'}
      ])
    ]);
    const res = makeResource('https://example.com/xxx/a/page.html');

    const downloaded = await pipeline.download(res);

    expect(downloaded).toBeDefined();
    expect(downloaded!.body).toBe('<html>mounted</html>');
    expect(downloaded!.meta.headers?.['content-length']).toBe('20');
    expect(downloaded!.meta.headers?.['content-type'])
      .toBe('text/html; charset=utf-8');
    expect(downloaded!.meta.localUrlMount).toMatchObject({
      root: sourceRoot,
      source: 'localUrlMount',
      localPath: path.join(sourceRoot, 'a', 'page.html')
    });
  });

  test('does not match a sibling prefix segment', async () => {
    await writeFile(path.join('a.js'), 'local');
    const fallback = jest.fn<DownloadResourceFunc>()
      .mockImplementation(res => {
        res.body = 'remote';
        return res as DownloadResource;
      });
    const pipeline = makePipeline([
      localUrlMounts([
        {root: sourceRoot, urlPrefix: 'https://example.com/xxx/'}
      ]),
      fallback
    ]);
    const res = makeResource(
      'https://example.com/xxx-other/a.js', ResourceType.Binary);

    const downloaded = await pipeline.download(res);

    expect(downloaded!.body).toBe('remote');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(res.meta.localUrlMount).toBeUndefined();
  });

  test('uses highest priority before longest prefix', async () => {
    const shorterRoot = path.join(tmpRoot, 'shorter');
    const longerRoot = path.join(tmpRoot, 'longer');
    await fs.mkdir(path.join(shorterRoot, 'api', 'v1'), {recursive: true});
    await fs.mkdir(longerRoot, {recursive: true});
    await fs.writeFile(path.join(shorterRoot, 'api', 'v1', 'users.html'),
      'shorter-priority');
    await fs.writeFile(path.join(longerRoot, 'users.html'),
      'longer-prefix');
    const pipeline = makePipeline([
      localUrlMounts([
        {
          root: longerRoot,
          urlPrefix: 'https://example.com/api/v1/',
          priority: 0,
        },
        {
          root: shorterRoot,
          urlPrefix: 'https://example.com/',
          priority: 10,
        },
      ])
    ]);
    const res = makeResource('https://example.com/api/v1/users.html');

    const downloaded = await pipeline.download(res);

    expect(downloaded!.body).toBe('shorter-priority');
  });

  test('uses longest prefix when priority ties', async () => {
    const baseRoot = path.join(tmpRoot, 'base');
    const nestedRoot = path.join(tmpRoot, 'nested');
    await fs.mkdir(path.join(baseRoot, 'api', 'v1'), {recursive: true});
    await fs.mkdir(nestedRoot, {recursive: true});
    await fs.writeFile(path.join(baseRoot, 'api', 'v1', 'users.html'), 'base');
    await fs.writeFile(path.join(nestedRoot, 'users.html'), 'nested');
    const pipeline = makePipeline([
      localUrlMounts([
        {root: baseRoot, urlPrefix: 'https://example.com/'},
        {root: nestedRoot, urlPrefix: 'https://example.com/api/v1/'},
      ])
    ]);
    const res = makeResource('https://example.com/api/v1/users.html');

    const downloaded = await pipeline.download(res);

    expect(downloaded!.body).toBe('nested');
  });

  test('resolves HTML directory index and extension fallback', async () => {
    await writeFile('index.html', 'root index');
    await writeFile(path.join('docs', 'intro.html'), 'intro extension');
    await writeFile(path.join('guide', 'index.htm'), 'guide index');
    const pipeline = makePipeline([
      localUrlMounts([
        {root: sourceRoot, urlPrefix: 'https://example.com/'}
      ])
    ]);

    const rootIndex = await pipeline.download(
      makeResource('https://example.com/'));
    const extension = await pipeline.download(
      makeResource('https://example.com/docs/intro'));
    const index = await pipeline.download(
      makeResource('https://example.com/guide/'));

    expect(rootIndex!.body).toBe('root index');
    expect(extension!.body).toBe('intro extension');
    expect(index!.body).toBe('guide index');
  });

  test('does not apply extension fallback for non-HTML resources', async () => {
    await writeFile('asset.html', 'html asset');
    const fallback = jest.fn<DownloadResourceFunc>().mockReturnValue(undefined);
    const pipeline = makePipeline([
      localUrlMounts([
        {root: sourceRoot, urlPrefix: 'https://example.com/'}
      ]),
      fallback
    ]);
    const res = makeResource('https://example.com/asset', ResourceType.Binary);

    const downloaded = await pipeline.download(res);

    expect(downloaded).toBeUndefined();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  test('supports lowercase, uppercase, and case-insensitive lookup modes',
    async () => {
      const lowerRoot = path.join(tmpRoot, 'lower');
      const upperRoot = path.join(tmpRoot, 'upper');
      const mixedRoot = path.join(tmpRoot, 'mixed');
      await fs.mkdir(path.join(lowerRoot, 'docs'), {recursive: true});
      await fs.mkdir(path.join(upperRoot, 'DOCS'), {recursive: true});
      await fs.mkdir(path.join(mixedRoot, 'Docs'), {recursive: true});
      await fs.writeFile(path.join(lowerRoot, 'docs', 'page.html'), 'lower');
      await fs.writeFile(path.join(upperRoot, 'DOCS', 'PAGE.HTML'), 'upper');
      await fs.writeFile(path.join(mixedRoot, 'Docs', 'Page.html'), 'mixed');
      const pipeline = makePipeline([
        localUrlMounts([
          {
            root: lowerRoot,
            urlPrefix: 'https://lower.example/',
            caseMode: 'lowercase',
          },
          {
            root: upperRoot,
            urlPrefix: 'https://upper.example/',
            caseMode: 'uppercase',
          },
          {
            root: mixedRoot,
            urlPrefix: 'https://mixed.example/',
            caseMode: 'caseInsensitive',
          },
        ])
      ]);

      const lower = await pipeline.download(
        makeResource('https://lower.example/DOCS/PAGE.HTML'));
      const upper = await pipeline.download(
        makeResource('https://upper.example/docs/page.html'));
      const mixed = await pipeline.download(
        makeResource('https://mixed.example/docs/page.html'));

      expect(lower!.body).toBe('lower');
      expect(upper!.body).toBe('upper');
      expect(mixed!.body).toBe('mixed');
    });

  test('ignores search by default and can preserve it in filenames', async () => {
    await writeFile('app.js', 'ignored search');
    await writeFile('style_a=1.css', 'preserved search');
    const pipeline = makePipeline([
      localUrlMounts([
        {
          root: sourceRoot,
          urlPrefix: 'https://ignore.example/',
        },
        {
          root: sourceRoot,
          urlPrefix: 'https://preserve.example/',
          search: 'preserve',
        },
      ])
    ]);

    const ignored = await pipeline.download(
      makeResource('https://ignore.example/app.js?v=1', ResourceType.Binary));
    const preserved = await pipeline.download(
      makeResource('https://preserve.example/style.css?a=1', ResourceType.Binary));

    expect(ignored!.body).toStrictEqual(Buffer.from('ignored search'));
    expect(preserved!.body).toStrictEqual(Buffer.from('preserved search'));
  });

  test('falls back to the next download handler when configured', async () => {
    const fallback = jest.fn<DownloadResourceFunc>()
      .mockImplementation(res => {
        res.body = 'remote';
        return res as DownloadResource;
      });
    const pipeline = makePipeline([
      localUrlMounts([
        {
          root: sourceRoot,
          urlPrefix: 'https://example.com/',
          notFound: 'fallback',
        }
      ]),
      fallback
    ]);
    const res = makeResource('https://example.com/missing.html');

    const downloaded = await pipeline.download(res);

    expect(downloaded!.body).toBe('remote');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(res.meta.localUrlMount).toMatchObject({
      root: sourceRoot,
      source: 'localUrlMount'
    });
  });

  test('can discard or throw when a matched file is missing', async () => {
    const discardPipeline = makePipeline([
      localUrlMounts([
        {
          root: sourceRoot,
          urlPrefix: 'https://discard.example/',
          notFound: 'discard',
        }
      ])
    ]);
    const throwPipeline = makePipeline([
      localUrlMounts([
        {
          root: sourceRoot,
          urlPrefix: 'https://throw.example/',
          notFound: 'throw',
        }
      ])
    ]);

    await expect(discardPipeline.download(
      makeResource('https://discard.example/missing.html')))
      .resolves.toBeUndefined();
    await expect(throwPipeline.download(
      makeResource('https://throw.example/missing.html')))
      .rejects.toThrow(LocalUrlMountNotFoundError);
  });

  test('return404 throws a synthetic 404 without hitting later handlers', async () => {
    const fallback = jest.fn<DownloadResourceFunc>();
    const pipeline = makePipeline([
      localUrlMounts([
        {
          root: sourceRoot,
          urlPrefix: 'https://example.com/',
          notFound: 'return404',
        }
      ]),
      fallback
    ]);
    const res = makeResource('https://example.com/missing.html');

    await expect(pipeline.download(res)).rejects.toMatchObject({
      name: 'LocalUrlMountNotFoundError',
      statusCode: 404,
      response: {statusCode: 404},
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(res.meta.localUrlMount).toMatchObject({
      statusCode: 404,
      source: 'localUrlMount',
    });
  });

  test('rejects encoded traversal and falls back without escaping root',
    async () => {
      await fs.writeFile(path.join(tmpRoot, 'secret.html'), 'secret');
      const fallback = jest.fn<DownloadResourceFunc>().mockReturnValue(undefined);
      const pipeline = makePipeline([
        localUrlMounts([
          {
            root: sourceRoot,
            urlPrefix: 'https://example.com/',
            notFound: 'fallback',
          }
        ]),
        fallback
      ]);
      const res = makeResource('https://example.com/%2e%2e/secret.html');

      const downloaded = await pipeline.download(res);

      expect(downloaded).toBeUndefined();
      expect(fallback).toHaveBeenCalledTimes(1);
      expect((res.meta.localUrlMount as LocalUrlMountMeta).candidatePaths)
        .toStrictEqual([]);
    });

  test('copies streaming binary hits directly to the destination path',
    async () => {
      await writeFile(path.join('media', 'video.bin'), 'video-body');
      const pipeline = makePipeline([
        localUrlMounts([
          {root: sourceRoot, urlPrefix: 'https://example.com/'}
        ])
      ]);
      const res = makeResource(
        'https://example.com/media/video.bin',
        ResourceType.StreamingBinary);

      const downloaded = await pipeline.download(res);

      expect(downloaded).toBeUndefined();
      await expect(fs.readFile(
        path.join(destinationRoot, 'example.com', 'media', 'video.bin')))
        .resolves.toStrictEqual(Buffer.from('video-body'));
      expect(res.body).toBeUndefined();
      expect(res.meta.localUrlMount).toMatchObject({
        localPath: path.join(sourceRoot, 'media', 'video.bin')
      });
    });
});
