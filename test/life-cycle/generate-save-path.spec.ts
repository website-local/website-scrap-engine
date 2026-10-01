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

test('save-path hook URI mutations cannot redirect the resource or share mutable URI state', async () => {
  let hookUri: GenerateSavePathContext['uri'] | undefined;
  const pipeline = new PipelineExecutorImpl(makeLifeCycle([async (savePath, context) => {
    hookUri = context.uri;
    context.uri.hostname('mutated.example');
    return savePath;
  }]), {}, fakeOpt);
  const res = await pipeline.createResource(ResourceType.Html, 1, '/docs/',
    'https://example.com/index.html');
  expect(res!.url).toBe('https://example.com/docs/');
  expect(res!.uri.toString()).toBe(res!.url);
  expect(res!.host).toBe('example.com');
  hookUri!.path('/late-change');
  expect(res!.uri.path()).toBe('/docs/');
});

test('custom resource factories retain their argument contract without implicit normalization', async () => {
  const lifeCycle = makeLifeCycle();
  lifeCycle.createResource = (...args) => {
    expect(args).toHaveLength(1);
    const res = createResource(args[0]);
    res.url = 'https://custom.example/replaced';
    return res;
  };
  const pipeline = new PipelineExecutorImpl(lifeCycle, {}, fakeOpt);
  const res = await pipeline.createResource(ResourceType.Html, 1, '/docs/',
    'https://example.com/index.html');
  expect(res!.url).toBe('https://custom.example/replaced');
  expect(res!.uri.toString()).toBe('https://example.com/docs/');
  expect(res!.host).toBe('example.com');
});

test('cached reference parsing does not share mutable state between resources', async () => {
  const pipeline = new PipelineExecutorImpl(makeLifeCycle(), {}, fakeOpt);
  const first = await pipeline.createResource(ResourceType.Html, 1, '/first', 'https://example.com/base');
  first!.refUri.hostname('changed.example');
  const second = await pipeline.createResource(ResourceType.Html, 1, '/second', 'https://example.com/base');
  expect(second!.refUri.toString()).toBe('https://example.com/base');
  expect(second!.url).toBe('https://example.com/second');
  expect(second!.refUri).not.toBe(first!.refUri);
});

test('legacy full generators preserve transforming hook order and reference paths', async () => {
  const legacy = wrapLegacyGenerateSavePath(() => 'custom/page.html');
  const inputs: string[] = [];
  const transform: GenerateSavePathFunc = async (savePath, context) => {
    inputs.push(savePath);
    expect(context.refSavePath).toBe(normalize('example.com/base.html'));
    return savePath;
  };
  for (const hooks of [[legacy, transform], [transform, legacy, transform]]) {
    const pipeline = new PipelineExecutorImpl(makeLifeCycle(hooks), {}, fakeOpt);
    const res = await pipeline.createResource(ResourceType.Html, 1, '/page',
      'https://example.com/base.html', undefined, undefined,
      normalize('example.com/base.html'), ResourceType.Html);
    expect(res!.savePath).toBe('custom/page.html');
    expect(res!.refSavePath).toBe(normalize('example.com/base.html'));
    expect(res!.replacePath).toBe('../custom/page.html');
  }
  expect(inputs).toEqual(['custom/page.html', normalize('example.com/page.html'), 'custom/page.html']);
});
