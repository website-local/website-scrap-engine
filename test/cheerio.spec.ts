import {describe, expect, jest, test} from '@jest/globals';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {disposeHtmlResource, load, prepareHtmlParser} from '../src/cheerio.js';
import {defaultDownloadOptions, mergeOverrideOptions} from '../src/options.js';
import {defaultLifeCycle} from '../src/life-cycle/default-life-cycle.js';
import {PipelineExecutorImpl} from '../src/downloader/pipeline-executor-impl.js';
import {SingleThreadDownloader} from '../src/downloader/single.js';
import {createResource, ResourceType} from '../src/resource.js';
import type {Resource} from '../src/resource.js';
import {state} from './grovedom-fixture.js';

const options = {localRoot: 'offline', htmlParser: 'grovedom' as const, grovedom: {
  module: new URL('./grovedom-fixture.cjs', import.meta.url).href,
  poolSize: 0, poolMaxBytes: 0
}};

const resource = (body = '<p>resource</p>') => Object.assign(createResource({
  type: ResourceType.Html, depth: 0, url: 'https://example.org/',
  refUrl: 'https://example.org/', localRoot: 'offline'
}), {body});

describe('explicit HTML parser ownership', () => {
  test('initializes once with pool limits and keeps nested documents independently owned', async () => {
    await Promise.all([prepareHtmlParser(options), prepareHtmlParser(options)]);
    const first = resource('<p>first</p>'), child = resource('<p>child</p>');
    const firstDocument = first.meta.doc = load(first.body, undefined, undefined, options);
    const childDocument = child.meta.doc = firstDocument.load(child.body);
    expect(firstDocument.html() + childDocument.html()).toContain('child');
    expect(state.initializations).toEqual([{heap: 'pool', poolSize: 0, poolMaxBytes: 0}]);
    await disposeHtmlResource(first);
    expect(first.meta.doc).toBeUndefined();
    expect(() => firstDocument.html()).toThrow('Disposed');
    expect(childDocument.html()).toContain('child');
    await disposeHtmlResource(child);
    expect(child.meta.doc).toBeUndefined();
    expect(() => childDocument.html()).toThrow('Disposed');
    expect(state.documents).toHaveLength(2);
    expect(state.documents.every(doc => doc.closed && doc.disposals === 1)).toBe(true);
  });

  test('keeps concurrent resources and default Cheerio loads independent', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const retained = resource('<p>pending</p>'), other = resource('<p>other</p>');
    const document = retained.meta.doc = load(retained.body, undefined, undefined, options);
    const plain = load('<p>cheerio</p>');
    const pending = gate.then(async () => {
      expect(document.html()).toContain('pending');
      await disposeHtmlResource(retained);
    });
    other.meta.doc = load(other.body, undefined, undefined, options);
    await disposeHtmlResource(other);
    expect(document.html()).toContain('pending');
    release();
    await pending;
    expect(() => document.html()).toThrow('Disposed');
    expect(plain.html()).toContain('cheerio');
  });

  test('clears a failing document and does not dispose it twice', () => {
    const res = resource('<p data-dispose-error>failure</p>');
    res.meta.doc = load(res.body, undefined, undefined, options);
    const record = state.documents[state.documents.length - 1];
    expect(() => disposeHtmlResource(res)).toThrow('Injected disposal failure');
    expect(res.meta.doc).toBeUndefined();
    expect(record).toEqual({closed: true, disposals: 1});
    expect(disposeHtmlResource(res)).toBeUndefined();
    expect(record.disposals).toBe(1);
  });

  test('explicitly releases a document before replacing it and allows a fresh retry', async () => {
    const res = resource();
    const before = state.documents.length;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(res.meta.doc).toBeUndefined();
      res.meta.doc = load('<p>initial</p>', undefined, undefined, options);
      await disposeHtmlResource(res);
      res.meta.doc = load('<p>replacement</p>', undefined, undefined, options);
      expect(res.meta.doc.html()).toContain('replacement');
      await disposeHtmlResource(res);
    }
    expect(state.documents.slice(before).every(doc => doc.closed && doc.disposals === 1)).toBe(true);
  });

  test.each(['submit', 'addProcessedResource'] as const)(
    '%s releases a distinct duplicate document after status listeners finish', async method => {
      const accepted = resource('<p>accepted</p>'), duplicate = resource('<p>duplicate</p>');
      const parent = resource();
      parent.discoveredCount = 0;
      const observed: string[] = [];
      const crawler = new SingleThreadDownloader(new URL('./downloader/budget-options.js', import.meta.url).href);
      const before = state.documents.length;
      try {
        await crawler.init;
        crawler.pipeline.lifeCycle.statusChange = [async (res, status) => {
          if (status !== 'dispose') return;
          await Promise.resolve();
          observed.push(res.meta.doc!.html());
        }];
        const acceptedDocument = accepted.meta.doc = load(accepted.body, undefined, undefined, options);
        const duplicateDocument = duplicate.meta.doc = load(duplicate.body, undefined, undefined, options);
        expect(crawler.addProcessedResource(accepted)).toBe(true);
        if (method === 'submit') crawler.submit(duplicate, parent, crawler.pipeline);
        else expect(crawler.addProcessedResource(duplicate)).toBe(false);
        await Promise.all(crawler.notifications);
        expect(observed).toEqual([expect.stringContaining('duplicate')]);
        expect(duplicate.meta.doc).toBeUndefined();
        expect(() => duplicateDocument.html()).toThrow('Disposed');
        expect(acceptedDocument.html()).toContain('accepted');
        expect(crawler.queueSize).toBe(1);
        expect(state.documents.slice(before)).toEqual([
          {closed: false, disposals: 0}, {closed: true, disposals: 1}
        ]);
      } finally {
        await crawler.dispose();
        await disposeHtmlResource(accepted);
        await disposeHtmlResource(duplicate);
      }
    });

  test.each(['submit', 'addProcessedResource'] as const)(
    '%s preserves the document when the same queued object is submitted twice', async method => {
      const accepted = resource('<p>accepted</p>'), parent = resource();
      parent.discoveredCount = 0;
      const crawler = new SingleThreadDownloader(new URL('./downloader/budget-options.js', import.meta.url).href);
      try {
        await crawler.init;
        const document = accepted.meta.doc = load(accepted.body, undefined, undefined, options);
        expect(crawler.addProcessedResource(accepted)).toBe(true);
        if (method === 'submit') crawler.submit(accepted, parent, crawler.pipeline);
        else expect(crawler.addProcessedResource(accepted)).toBe(false);
        await Promise.all(crawler.notifications);
        expect(accepted.meta.doc).toBe(document);
        expect(document.html()).toContain('accepted');
        expect(crawler.queueSize).toBe(1);
      } finally {
        await crawler.dispose();
        await disposeHtmlResource(accepted);
      }
    });

  test.each([false, true])('pipeline replacement transfers document ownership: %s', async transfer => {
    const initial = resource('<p>initial</p>'), replacement = resource('<p>replacement</p>');
    const original = initial.meta.doc = load(initial.body, undefined, undefined, options);
    const document = replacement.meta.doc = transfer ? original :
      load(replacement.body, undefined, undefined, options);
    const config = defaultDownloadOptions({...defaultLifeCycle(), ...options,
      processAfterDownload: [() => replacement]});
    const pipeline = new PipelineExecutorImpl(config, config.req, config);
    expect(await pipeline.processAfterDownload(initial, () => {})).toBe(replacement);
    expect(initial.meta.doc).toBeUndefined();
    expect(document.html()).toContain(transfer ? 'initial' : 'replacement');
    if (!transfer) expect(() => original.html()).toThrow('Disposed');
    await disposeHtmlResource(replacement);
    expect(() => document.html()).toThrow('Disposed');
  });

  test('disposes a custom factory document when its supplied body exceeds the input limit', async () => {
    const created = resource('<p>oversized factory body</p>');
    const document = created.meta.doc = load(created.body, undefined, undefined, options);
    const record = state.documents[state.documents.length - 1];
    const config = defaultDownloadOptions({...defaultLifeCycle(), ...options,
      maxResourceBytes: 1, createResource: () => created});
    const pipeline = new PipelineExecutorImpl(config, config.req, config);
    try {
      expect(await pipeline.createResource(ResourceType.Html, 0,
        created.url, created.refUrl)).toBeUndefined();
      expect(created.shouldBeDiscardedFromDownload).toBe(true);
      expect(created.meta.error).toBeUndefined();
      expect(created.meta.doc).toBeUndefined();
      expect(record).toEqual({closed: true, disposals: 1});
      expect(() => document.html()).toThrow('Disposed');
    } finally {
      await disposeHtmlResource(created);
    }
  });

  test('rewrites a discard-only child link and releases its pre-download document', async () => {
    const parent = resource('<html><body><a href="/child.html">child</a></body></html>');
    let child: Resource | undefined;
    const before = state.documents.length;
    const config = defaultDownloadOptions({...defaultLifeCycle(), ...options,
      processBeforeDownload: [res => {
        child = res;
        res.body = '<p>discarded child</p>';
        res.meta.doc = load(res.body, undefined, undefined, options);
        res.shouldBeDiscardedFromDownload = true;
        return res;
      }]});
    const pipeline = new PipelineExecutorImpl(config, config.req, config);
    const submit = jest.fn();
    try {
      expect(await pipeline.processAfterDownload(parent, submit)).toBe(parent);
      expect(submit).not.toHaveBeenCalled();
      expect(child!.shouldBeDiscardedFromDownload).toBe(true);
      expect(parent.meta.doc!('a').attr('href')).toBe(child!.replacePath);
      expect(child!.meta.doc).toBeUndefined();
      expect(state.documents[before + 1]).toEqual({closed: true, disposals: 1});
    } finally {
      await disposeHtmlResource(parent);
      if (child) await disposeHtmlResource(child);
    }
  });

  test.each(['processBeforeDownload', 'download', 'processAfterDownload', 'saveToDisk'] as const)(
    '%s releases the replacement document when the previous disposal fails', async stage => {
      const initial = resource('<p data-dispose-error>initial</p>');
      const replacement = resource('<p>replacement</p>');
      const before = state.documents.length;
      initial.meta.doc = load(initial.body, undefined, undefined, options);
      replacement.meta.doc = load(replacement.body, undefined, undefined, options);
      const config = defaultDownloadOptions({...defaultLifeCycle(), ...options,
        [stage]: [() => replacement]});
      const pipeline = new PipelineExecutorImpl(config, config.req, config);
      try {
        const pending = stage === 'processBeforeDownload' ? pipeline.processBeforeDownload(initial, null, null) :
          stage === 'processAfterDownload' ? pipeline.processAfterDownload(initial, () => {}) :
            pipeline[stage](initial);
        await expect(pending).rejects.toThrow('Injected disposal failure');
        expect(initial.meta.doc).toBeUndefined();
        expect(replacement.meta.doc).toBeUndefined();
        expect(state.documents.slice(before)).toEqual([
          {closed: true, disposals: 1}, {closed: true, disposals: 1}
        ]);
      } finally {
        await disposeHtmlResource(initial);
        await disposeHtmlResource(replacement);
      }
    });

  test('standalone lifecycle parsing is lazy and saving releases the document', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wse-parser-save-'));
    const config = defaultDownloadOptions({...defaultLifeCycle(), ...options, localRoot: root});
    const pipeline = new PipelineExecutorImpl(config, config.req, config);
    const res = resource('<p>test</p><iframe srcdoc="&lt;p&gt;nested&lt;/p&gt;"></iframe>');
    res.localRoot = root;
    const before = state.documents.length;
    expect(res.meta.doc).toBeUndefined();
    try {
      expect(await pipeline.processAfterDownload(res, () => {})).toBe(res);
      const document = res.meta.doc!;
      expect(document.html()).toContain('nested');
      expect(state.documents.slice(before).map(doc => doc.closed)).toEqual([false, true]);
      await pipeline.saveToDisk(res);
      expect(await readFile(path.join(root, res.savePath), 'utf8')).toContain('nested');
      expect(res.meta.doc).toBeUndefined();
      expect(() => document.html()).toThrow('Disposed');
      expect(state.documents.slice(before).every(doc => doc.closed && doc.disposals === 1)).toBe(true);
    } finally {
      await disposeHtmlResource(res);
      await rm(root, {recursive: true, force: true});
    }
  });

  test('rejects conflicting pool initialization within one process', () => {
    expect(() => load('<p>conflict</p>', undefined, undefined,
      {...options, grovedom: {...options.grovedom, poolSize: 1}})).toThrow('pool options must agree');
  });

  test.each(['../test/grovedom-fixture.cjs', options.grovedom.module + '?alias=1',
    options.grovedom.module + '#alias'])(
    'module alias %s shares initialization and pool limits', async module => {
      const alias = {...options, grovedom: {...options.grovedom, module}};
      await prepareHtmlParser(alias);
      const res = resource('<p>aliased document</p>');
      const document = res.meta.doc = load(res.body, undefined, undefined, alias);
      expect(document.html()).toContain('aliased document');
      expect(state.initializations).toHaveLength(1);
      expect(() => load('', undefined, undefined,
        {...alias, grovedom: {...alias.grovedom, poolSize: 1}})).toThrow('pool options must agree');
      await disposeHtmlResource(res);
      expect(() => document.html()).toThrow('Disposed');
    });

  test('binary lifecycles do not load a configured missing parser', async () => {
    const config = defaultDownloadOptions({...defaultLifeCycle(), ...options,
      grovedom: {module: 'wse-missing-grovedom-test-package'}, download: [res => res]});
    const pipeline = new PipelineExecutorImpl(config, config.req, config);
    const res = Object.assign(createResource({type: ResourceType.Binary, depth: 0,
      url: 'https://example.org/binary', refUrl: 'https://example.org/', localRoot: 'offline'}),
    {body: Buffer.from([0, 1])});
    const before = state.documents.length;
    expect(await pipeline.download(res)).toBe(res);
    expect(await pipeline.processAfterDownload(res, () => {})).toBe(res);
    expect(res.meta.doc).toBeUndefined();
    expect(state.documents).toHaveLength(before);
  });

  test.each(['size', 'cancellation'] as const)('clears replacement download documents after %s', async failure => {
    const controller = new AbortController();
    const initial = resource(''), replacement = resource('<p>replacement</p>');
    const config = defaultDownloadOptions({...defaultLifeCycle(), ...options,
      maxResourceBytes: failure === 'size' ? 1 : undefined,
      download: [() => {
        replacement.meta.doc = load(replacement.body, undefined, undefined, options);
        if (failure === 'cancellation') controller.abort(new Error('cancelled download'));
        return replacement;
      }]
    });
    const pipeline = new PipelineExecutorImpl(config, config.req, config, controller.signal);
    if (failure === 'size') {
      await expect(pipeline.download(initial)).resolves.toBeUndefined();
      expect(replacement.shouldBeDiscardedFromDownload).toBe(true);
      expect(replacement.meta.error).toBeUndefined();
    } else await expect(pipeline.download(initial)).rejects.toThrow('cancelled download');
    expect(replacement.meta.doc).toBeUndefined();
    expect(state.documents[state.documents.length - 1]).toEqual({closed: true, disposals: 1});
  });

  test.each(['download', 'processAfterDownload', 'saveToDisk'] as const)(
    '%s clears an owned input document when already cancelled', async stage => {
      const controller = new AbortController();
      const config = defaultDownloadOptions({...defaultLifeCycle(), ...options});
      const pipeline = new PipelineExecutorImpl(config, config.req, config, controller.signal);
      const res = resource('<p>cancelled</p>');
      const document = res.meta.doc = load(res.body, undefined, undefined, options);
      controller.abort(new Error('cancelled before processing'));
      const pending = stage === 'processAfterDownload' ? pipeline.processAfterDownload(res, () => {}) :
        pipeline[stage](res);
      await expect(pending).rejects.toThrow('cancelled before processing');
      expect(res.meta.doc).toBeUndefined();
      expect(() => document.html()).toThrow('Disposed');
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
