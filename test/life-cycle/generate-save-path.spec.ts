import {describe, expect, jest, test} from '@jest/globals';
import {join, normalize, resolve} from 'node:path';
import {createResource, ResourceType} from '../../src/resource.js';
import type {GenerateSavePathFn, Resource} from '../../src/resource.js';
import type {ProcessingLifeCycle} from '../../src/life-cycle/types.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import type {StaticDownloadOptions} from '../../src/options.js';

const fakeOpt = {
  concurrency: 1,
  deduplicateStripSearch: true,
  encoding: {},
  localRoot: resolve('test-output'),
  maxDepth: 5,
  meta: {}
} as StaticDownloadOptions;

function makeLifeCycle(generateSavePath?: GenerateSavePathFn): ProcessingLifeCycle {
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

describe('save-path callback compatibility', () => {
  test('the default lifecycle leaves the optional callback unset', () => {
    expect(defaultLifeCycle().generateSavePath).toBeUndefined();
  });

  test('creates a resource synchronously without a custom callback', () => {
    const pipeline = new PipelineExecutorImpl(makeLifeCycle(), {}, fakeOpt);
    const res: Resource = pipeline.createResource(
      ResourceType.Html, 1, '/docs/', 'https://example.com/index.html',
      undefined, undefined, undefined, ResourceType.Html
    );

    expect(res.url).toBe('https://example.com/docs/');
    expect(res.savePath).toBe(normalize('example.com/docs/index.html'));
    expect(res.replacePath).toBe('docs/index.html');
  });

  test.each([
    ['https://example.com/../../evil.txt', 'example.com/_/_/evil.txt'],
    ['https://example.com/%2e%2e/evil.txt', 'example.com/_/evil.txt']
  ])('sanitizes dot segments in %s', (url, expectedPath) => {
    const pipeline = new PipelineExecutorImpl(makeLifeCycle(), {}, fakeOpt);
    const res = pipeline.createResource(
      ResourceType.Binary, 1, url, 'https://example.com/index.html'
    );

    expect(res.savePath).toBe(normalize(expectedPath));
    expect(decodeURI(res.savePath)).not.toContain('..');
  });

  test('calls the full generator for the resource and its parent path', () => {
    const generator = jest.fn<GenerateSavePathFn>((uri, isHtml) =>
      join('legacy', uri.hostname(), isHtml ? 'page.html' : 'file.bin'));
    const pipeline = new PipelineExecutorImpl(makeLifeCycle(generator), {}, {
      ...fakeOpt, deduplicateStripSearch: false
    });
    const res = pipeline.createResource(
      ResourceType.Binary, 2, 'https://cdn.example.com/app.js?v=1',
      'https://example.com/index.html', undefined, undefined, undefined,
      ResourceType.Html
    );

    expect(res.savePath).toBe(join('legacy', 'cdn.example.com', 'file.bin'));
    expect(res.replacePath).toBe('../cdn.example.com/file.bin');
    expect(generator).toHaveBeenCalledTimes(2);
    expect(generator.mock.calls.map(([uri, isHtml, keepSearch]) =>
      [uri.hostname(), isHtml, keepSearch])).toStrictEqual([
      ['cdn.example.com', false, true],
      ['example.com', true, false]
    ]);
  });

  test('preserves an explicit parent path when using a custom callback', () => {
    const generator = jest.fn<GenerateSavePathFn>(() => join('assets', 'app.js'));
    const pipeline = new PipelineExecutorImpl(makeLifeCycle(generator), {}, fakeOpt);
    const res = pipeline.createResource(
      ResourceType.Binary, 2, 'https://cdn.example.com/app.js',
      'https://example.com/index.html', undefined, undefined,
      join('pages', 'index.html'), ResourceType.Html
    );

    expect(res.savePath).toBe(join('assets', 'app.js'));
    expect(res.replacePath).toBe('../assets/app.js');
    expect(generator).toHaveBeenCalledTimes(1);
  });
});
