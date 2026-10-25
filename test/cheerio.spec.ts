import {describe, expect, test} from '@jest/globals';
import {load, withHtmlParser, withResourceHtmlParser, prepareHtmlParser, trackHtmlResource} from '../src/cheerio.js';
import {defaultDownloadOptions, mergeOverrideOptions} from '../src/options.js';
import {defaultLifeCycle} from '../src/life-cycle/default-life-cycle.js';
import {PipelineExecutorImpl} from '../src/downloader/pipeline-executor-impl.js';
import {createResource, ResourceType} from '../src/resource.js';
import type {CheerioStatic} from '../src/types.js';
import {state} from './grovedom-fixture.js';

const options = {localRoot: 'offline', htmlParser: 'grovedom' as const, grovedom: {
  module: new URL('./grovedom-fixture.cjs', import.meta.url).href,
  poolSize: 0, poolMaxBytes: 0
}};

describe('scoped HTML parser', () => {
  test('initializes once with downstream pool limits and owns nested loads until final serialization', async () => {
    let first!: CheerioStatic, child!: CheerioStatic;
    const output = await withHtmlParser(options, async () => {
      await Promise.all([prepareHtmlParser(options), prepareHtmlParser(options)]);
      first = load('<p>first</p>');
      await withHtmlParser(options, () => { child = first.load('<p>child</p>'); });
      expect(child.html()).toContain('child');
      return first.html() + child.html();
    });
    expect(output).toContain('first');
    expect(state.initializations).toEqual([{heap: 'pool', poolSize: 0, poolMaxBytes: 0}]);
    expect(state.documents).toHaveLength(2);
    expect(state.documents.every(doc => doc.closed && doc.disposals === 1)).toBe(true);
    expect(() => first.html()).toThrow('Disposed');
    expect(() => child.html()).toThrow('Disposed');
    expect(() => first.load('<p>late</p>')).toThrow('scope has finished');
  });

  test('keeps concurrent scopes and explicitly nested Cheerio scopes independent', async () => {
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { ready = resolve; });
    let retained!: CheerioStatic, plain!: CheerioStatic;
    const pending = withHtmlParser(options, async () => {
      retained = load('<p>pending</p>');
      plain = await withHtmlParser({}, () => load('<p>cheerio</p>'));
      ready();
      await gate;
      expect(retained.html()).toContain('pending');
    });
    await started;
    await withHtmlParser(options, () => { load('<p>other</p>'); });
    expect(retained.html()).toContain('pending');
    release();
    await pending;
    expect(plain.html()).toContain('cheerio');
  });

  test('disposes every document even if one disposal fails, preserving a primary failure', async () => {
    const before = state.documents.length;
    await expect(withHtmlParser(options, () => {
      load('<p data-dispose-error>one</p>');
      load('<p>two</p>');
      throw new Error('Primary failure');
    })).rejects.toThrow('Primary failure');
    expect(state.documents.slice(before).every(doc => doc.closed && doc.disposals === 1)).toBe(true);
    await expect(withHtmlParser(options, () => { load('<p data-dispose-error></p>'); }))
      .rejects.toThrow('HTML document disposal failed');
  });

  test('a resource submitted by a parent owns its own lifetime', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let child!: Promise<void>, document!: CheerioStatic;
    await withHtmlParser(options, () => {
      child = withResourceHtmlParser(options, async () => {
        document = load('<p>child resource</p>');
        await gate;
        expect(document.html()).toContain('child resource');
      });
    });
    expect(document.html()).toContain('child resource');
    release();
    await child;
    expect(() => document.html()).toThrow('Disposed');
  });

  test('clears replaced documents from resources and allows a fresh retry', async () => {
    const resource: {meta: {doc?: CheerioStatic}} = {meta: {}};
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(withHtmlParser(options, () => {
        trackHtmlResource(resource);
        expect(resource.meta.doc).toBeUndefined();
        resource.meta.doc = load('<p>initial</p>');
        resource.meta.doc = load('<p>replacement</p>');
        throw new Error('retry');
      })).rejects.toThrow('retry');
      expect(resource.meta.doc).toBeUndefined();
    }
  });

  test('rejects detached asynchronous loads after their owning scope finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let late!: Promise<void>;
    await withHtmlParser(options, () => {
      late = gate.then(() => { load('<p>too late</p>'); });
    });
    const rejected = expect(late).rejects.toThrow('scope has finished');
    release();
    await rejected;
  });

  test('requires an explicit owning scope for standalone GroveDOM pipeline calls', async () => {
    const config = defaultDownloadOptions({...defaultLifeCycle(), ...options});
    const pipeline = new PipelineExecutorImpl(config, config.req, config);
    const resource = Object.assign(createResource({type: ResourceType.Html, depth: 0,
      url: 'https://example.org/', refUrl: 'https://example.org/', localRoot: 'offline'}), {body: '<p>test</p>'});
    await expect(pipeline.processAfterDownload(resource, () => {})).rejects.toThrow('withHtmlParser');
  });

  test('rejects conflicting pool initialization within one process', () => {
    expect(() => withHtmlParser({...options, grovedom: {...options.grovedom, poolSize: 1}}, () => {}))
      .toThrow('pool options must agree');
  });

  test.each(['../test/grovedom-fixture.cjs', options.grovedom.module + '?alias=1',
    options.grovedom.module + '#alias'])(
    'module alias %s shares initialization, pool limits and nested ownership', async module => {
      const alias = {...options, grovedom: {...options.grovedom, module}};
      let document!: CheerioStatic;
      await withHtmlParser(options, async () => {
        await withHtmlParser(alias, async () => {
          await prepareHtmlParser(alias);
          document = load('<p>aliased child</p>');
        });
        expect(document.html()).toContain('aliased child');
        expect(() => withHtmlParser({...alias, grovedom: {...alias.grovedom, poolSize: 1}}, () => {}))
          .toThrow('pool options must agree');
      });
      expect(state.initializations).toHaveLength(1);
      expect(() => document.html()).toThrow('Disposed');
    });

  test('binary-only scopes do not require an installed parser package', async () => {
    await expect(withHtmlParser({htmlParser: 'grovedom', grovedom: {
      module: 'wse-missing-grovedom-test-package'
    }}, () => 'binary')).resolves.toBe('binary');
  });

  test.each(['size', 'cancellation'] as const)('clears replacement download documents after %s failures', async failure => {
    const controller = new AbortController();
    const initial = createResource({type: ResourceType.Html, depth: 0,
      url: 'https://example.org/', refUrl: 'https://example.org/', localRoot: 'offline'});
    const replacement = Object.assign(createResource({type: ResourceType.Html, depth: 0,
      url: 'https://example.org/replaced', refUrl: 'https://example.org/', localRoot: 'offline'}),
    {body: '<p>replacement</p>'});
    const config = defaultDownloadOptions({...defaultLifeCycle(), ...options,
      maxResourceBytes: failure === 'size' ? 1 : undefined,
      download: [() => {
        replacement.meta.doc = load(replacement.body);
        if (failure === 'cancellation') controller.abort(new Error('cancelled download'));
        return replacement;
      }]
    });
    const pipeline = new PipelineExecutorImpl(config, config.req, config, controller.signal);
    await withHtmlParser(options, async () => {
      await prepareHtmlParser(options);
      await expect(pipeline.download(initial)).rejects.toThrow();
    });
    expect(replacement.meta.doc).toBeUndefined();
  });

  test.each(['download', 'processAfterDownload', 'saveToDisk'] as const)(
    '%s clears an owned input document when already cancelled', async stage => {
      const controller = new AbortController();
      const config = defaultDownloadOptions({...defaultLifeCycle(), ...options});
      const pipeline = new PipelineExecutorImpl(config, config.req, config, controller.signal);
      const resource = Object.assign(createResource({type: ResourceType.Html, depth: 0,
        url: 'https://example.org/', refUrl: 'https://example.org/', localRoot: 'offline'}), {body: '<p>cancelled</p>'});
      await withHtmlParser(options, async () => {
        await prepareHtmlParser(options);
        resource.meta.doc = load(resource.body);
        controller.abort(new Error('cancelled before processing'));
        const pending = stage === 'processAfterDownload' ? pipeline.processAfterDownload(resource, () => {}) :
          pipeline[stage](resource);
        await expect(pending).rejects.toThrow('cancelled before processing');
      });
      expect(resource.meta.doc).toBeUndefined();
    });
});

test('pool options are validated, copied and merged through cloneable downstream overrides', () => {
  const config = defaultDownloadOptions({...defaultLifeCycle(), ...options});
  const override = {grovedom: {poolMaxBytes: 1024 * 1024}};
  const merged = mergeOverrideOptions(config, override);
  expect(merged.grovedom).toEqual({...options.grovedom, poolMaxBytes: 1024 * 1024});
  expect(config.grovedom).toEqual(options.grovedom);
  expect(config.grovedom).not.toBe(options.grovedom);
  expect(structuredClone(override)).toEqual(override);
  for (const value of [-1, 0.5, NaN, Infinity]) {
    for (const key of ['poolSize', 'poolMaxBytes']) {
      expect(() => defaultDownloadOptions({...defaultLifeCycle(), grovedom: {[key]: value}}))
        .toThrow('nonnegative safe integer');
    }
  }
  expect(() => defaultDownloadOptions({...defaultLifeCycle(), htmlParser: 'unknown' as 'grovedom'}))
    .toThrow('Unknown htmlParser');
});
