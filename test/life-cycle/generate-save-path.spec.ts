import {describe, expect, test} from '@jest/globals';
import {join, normalize} from 'node:path';
import {createResource, ResourceType} from '../../src/resource.js';
import {wrapLegacyGenerateSavePath} from '../../src/life-cycle/adapters.js';
import type {
  GenerateSavePathContext,
  GenerateSavePathFunc,
  ProcessingLifeCycle
} from '../../src/life-cycle/types.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import type {StaticDownloadOptions} from '../../src/options.js';

const fakeOpt = {
  concurrency: 1,
  deduplicateStripSearch: true,
  encoding: {},
  localRoot: '/tmp/root',
  maxDepth: 5,
  meta: {}
} as StaticDownloadOptions;

function makeLifeCycle(
  generateSavePath: GenerateSavePathFunc[] = []
): ProcessingLifeCycle {
  return {
    init: [],
    linkRedirect: [],
    detectResourceType: [],
    generateSavePath,
    createResource,
    processBeforeDownload: [],
    download: [],
    processAfterDownload: [],
    saveToDisk: [],
    dispose: [],
    statusChange: []
  };
}

describe('PipelineExecutorImpl.generateSavePath', () => {
  test('uses built-in save path when no hooks are registered', async () => {
    const pipeline = new PipelineExecutorImpl(makeLifeCycle(), {}, fakeOpt);

    const res = await pipeline.createResource(
      ResourceType.Html,
      1,
      '/docs/',
      'https://example.com/index.html',
      undefined,
      undefined,
      undefined,
      ResourceType.Html
    );

    expect(res).toBeDefined();
    expect(res!.url).toBe('https://example.com/docs/');
    expect(res!.savePath).toBe(normalize('example.com/docs/index.html'));
    expect(res!.replacePath).toBe('docs/index.html');
  });

  test('sanitizes dot segments before generating save paths', async () => {
    const pipeline = new PipelineExecutorImpl(makeLifeCycle(), {}, fakeOpt);

    const res = await pipeline.createResource(
      ResourceType.Binary,
      1,
      'https://example.com/../../evil.txt',
      'https://example.com/index.html',
      undefined,
      undefined,
      undefined,
      ResourceType.Html
    );

    expect(res).toBeDefined();
    expect(res!.savePath).toBe(normalize('example.com/_/_/evil.txt'));
    expect(res!.savePath).not.toContain('..');
  });

  test('sanitizes encoded dot segments before generating save paths', async () => {
    const pipeline = new PipelineExecutorImpl(makeLifeCycle(), {}, fakeOpt);

    const res = await pipeline.createResource(
      ResourceType.Binary,
      1,
      'https://example.com/%2e%2e/evil.txt',
      'https://example.com/index.html',
      undefined,
      undefined,
      undefined,
      ResourceType.Html
    );

    expect(res).toBeDefined();
    expect(res!.savePath).toBe(normalize('example.com/_/evil.txt'));
    expect(decodeURI(res!.savePath)).not.toContain('..');
  });

  test('runs hooks as a savePath transform chain', async () => {
    const calls: string[] = [];
    const pipeline = new PipelineExecutorImpl(makeLifeCycle([
      (savePath, ctx) => {
        calls.push(ctx.uri.hostname());
        return savePath.replace('cdn.example.com', 'assets');
      },
      savePath => join('mirror', savePath)
    ]), {}, fakeOpt);

    const res = await pipeline.createResource(
      ResourceType.Binary,
      2,
      'https://cdn.example.com/app.js',
      'https://example.com/index.html',
      undefined,
      undefined,
      normalize('example.com/index.html'),
      ResourceType.Html
    );

    expect(calls).toStrictEqual(['cdn.example.com']);
    expect(res).toBeDefined();
    expect(res!.savePath).toBe(join('mirror', 'assets', 'app.js'));
    expect(res!.replacePath).toBe('../mirror/assets/app.js');
  });

  test('allows refSavePath override', async () => {
    let secondHookRefSavePath = '';
    const pipeline = new PipelineExecutorImpl(makeLifeCycle([
      savePath => ({savePath, refSavePath: join('virtual', 'index.html')}),
      (savePath, ctx) => {
        secondHookRefSavePath = ctx.refSavePath;
        return savePath;
      }
    ]), {}, fakeOpt);

    const res = await pipeline.createResource(
      ResourceType.Binary,
      2,
      'https://example.com/assets/app.js',
      'https://example.com/index.html',
      undefined,
      undefined,
      normalize('example.com/index.html'),
      ResourceType.Html
    );

    expect(res).toBeDefined();
    expect(res!.replacePath).toBe('../example.com/assets/app.js');
    expect(secondHookRefSavePath).toBe(join('virtual', 'index.html'));
  });

  test('can discard a resource before createResource', async () => {
    const pipeline = new PipelineExecutorImpl(makeLifeCycle([
      () => undefined
    ]), {}, fakeOpt);

    const res = await pipeline.createResource(
      ResourceType.Binary,
      1,
      'https://example.com/skip.bin',
      'https://example.com/index.html'
    );

    expect(res).toBeUndefined();
  });

  test('passes a narrow read-only context', async () => {
    let context: GenerateSavePathContext | undefined;
    const pipeline = new PipelineExecutorImpl(makeLifeCycle([
      (savePath, ctx) => {
        context = ctx;
        return savePath;
      }
    ]), {}, fakeOpt);

    await pipeline.createResource(
      ResourceType.Html,
      3,
      'page.html',
      'https://example.com/docs/index.html',
      undefined,
      undefined,
      normalize('example.com/docs/index.html'),
      ResourceType.Html
    );

    expect(context).toBeDefined();
    expect(context!.type).toBe(ResourceType.Html);
    expect(context!.depth).toBe(3);
    expect(context!.rawUrl).toBe('page.html');
    expect(context!.refSavePath).toBe(normalize('example.com/docs/index.html'));
    expect('replacePath' in context!).toBe(false);
    expect('downloadLink' in context!).toBe(false);
    expect('meta' in context!).toBe(false);
  });

  test('wraps a legacy full save-path generator', async () => {
    const pipeline = new PipelineExecutorImpl(makeLifeCycle([
      wrapLegacyGenerateSavePath((uri, isHtml) =>
        join('legacy', uri.hostname(), isHtml ? 'page.html' : 'file.bin'))
    ]), {}, fakeOpt);

    const res = await pipeline.createResource(
      ResourceType.Html,
      1,
      'https://example.com/docs/',
      'https://example.com/index.html',
      undefined,
      undefined,
      normalize('example.com/index.html'),
      ResourceType.Html
    );

    expect(res).toBeDefined();
    expect(res!.savePath).toBe(join('legacy', 'example.com', 'page.html'));
  });
});
