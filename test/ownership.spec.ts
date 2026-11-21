import {describe, expect, jest, test} from '@jest/globals';
import {load} from 'cheerio';
import {disposeHtmlResource} from '../src/cheerio.js';
import {PipelineExecutorImpl} from '../src/downloader/pipeline-executor-impl.js';
import type {DownloadResource, ProcessingLifeCycle} from '../src/life-cycle/types.js';
import {defaultDownloadOptions} from '../src/options.js';
import {createResource, ResourceType} from '../src/resource.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return {promise, release};
}

function ownedResource(label: string) {
  const document: ReturnType<typeof load> & {dispose?: () => void} = load('<p>' + label + '</p>');
  const dispose = jest.fn<() => void>();
  document.dispose = dispose;
  const resource = createResource({
    type: ResourceType.Html, depth: 0,
    url: 'https://example.test/' + label + '.html', refUrl: 'https://example.test/',
    localRoot: 'offline'
  }) as DownloadResource;
  resource.body = '<p>' + label + '</p>';
  resource.meta.doc = document;
  return {resource, document, dispose};
}

function pipelineWith(hooks: Partial<ProcessingLifeCycle>) {
  const options = defaultDownloadOptions({
    init: [], linkRedirect: [], detectResourceType: [], createResource,
    processBeforeDownload: [], download: [], processAfterDownload: [],
    saveToDisk: [], dispose: [], statusChange: [], localRoot: 'offline',
    ...hooks
  });
  return new PipelineExecutorImpl(options, options.req, options);
}

describe('resource document ownership', () => {
  test('releases a replaced document before the next hook without releasing the replacement', async () => {
    const original = ownedResource('original');
    const replacement = ownedResource('replacement');
    const pipeline = pipelineWith({processAfterDownload: [
      () => replacement.resource,
      resource => {
        expect(original.dispose).toHaveBeenCalledTimes(1);
        expect(original.resource.meta.doc).toBeUndefined();
        expect(resource.meta.doc).toBe(replacement.document);
        expect(replacement.dispose).not.toHaveBeenCalled();
        return resource;
      }
    ]});

    const result = await pipeline.processAfterDownload(original.resource, () => {});
    expect(result).toBe(replacement.resource);
    await disposeHtmlResource(replacement.resource);
    await disposeHtmlResource(original.resource);
    expect(original.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.dispose).toHaveBeenCalledTimes(1);
  });

  test('keeps a shared document on its previous owner until asynchronous status readers finish', async () => {
    const original = ownedResource('shared');
    const statusGate = gate();
    const observations: unknown[] = [];
    const replacement = {...original.resource, meta: {...original.resource.meta}};
    const afterTransfer = jest.fn((resource: DownloadResource) => resource);
    const pipeline = pipelineWith({
      statusChange: [async resource => {
        await statusGate.promise;
        observations.push(resource.meta.doc === original.document,
          resource.meta.doc?.('p').text(), original.dispose.mock.calls.length);
      }],
      processAfterDownload: [() => replacement, afterTransfer]
    });
    void pipeline.notifyStatusChange(original.resource, 'processAfterDownload');
    const processing = pipeline.processAfterDownload(original.resource, () => {});

    expect(afterTransfer).not.toHaveBeenCalled();
    expect(original.resource.meta.doc).toBe(original.document);
    expect(original.dispose).not.toHaveBeenCalled();
    statusGate.release();
    expect(await processing).toBe(replacement);
    expect(observations).toEqual([true, 'shared', 0]);
    expect(afterTransfer).toHaveBeenCalledTimes(1);
    expect(original.resource.meta.doc).toBeUndefined();
    expect(original.resource.meta.statusChanges).toBeUndefined();
    expect(replacement.meta.doc).toBe(original.document);
    expect(original.dispose).not.toHaveBeenCalled();

    await disposeHtmlResource(original.resource);
    expect(original.dispose).not.toHaveBeenCalled();
    await disposeHtmlResource(replacement);
    expect(original.dispose).toHaveBeenCalledTimes(1);
  });

  test('releases both documents when a hook fails after an asynchronous replacement', async () => {
    const original = ownedResource('original');
    const replacement = ownedResource('replacement');
    const failure = new Error('later hook failed');
    const pipeline = pipelineWith({processAfterDownload: [
      async () => replacement.resource,
      () => { throw failure; }
    ]});

    await expect(pipeline.processAfterDownload(original.resource, () => {})).rejects.toBe(failure);
    expect(original.resource.meta.doc).toBeUndefined();
    expect(replacement.resource.meta.doc).toBeUndefined();
    expect(original.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.dispose).toHaveBeenCalledTimes(1);
    await disposeHtmlResource(original.resource);
    await disposeHtmlResource(replacement.resource);
    expect(original.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.dispose).toHaveBeenCalledTimes(1);
  });

  test('drains status work enqueued across an await before disposing, including rejected listeners', async () => {
    const owned = ownedResource('pending');
    const first = gate(), second = gate();
    const observations: unknown[] = [];
    const pipeline = pipelineWith({statusChange: [async (resource, status, _options, executor) => {
      if (status === 'download') {
        await first.promise;
        observations.push(status, resource.meta.doc?.('p').text(), owned.dispose.mock.calls.length);
        void executor.notifyStatusChange(resource, 'saveToDisk');
      } else {
        await second.promise;
        observations.push(status, resource.meta.doc?.('p').text(), owned.dispose.mock.calls.length);
        throw new Error('status observer rejected');
      }
    }]});
    const firstNotification = pipeline.notifyStatusChange(owned.resource, 'download');
    let completed = false;
    const disposing = Promise.resolve(disposeHtmlResource(owned.resource)).then(() => { completed = true; });
    expect(owned.resource.meta.doc).toBe(owned.document);
    expect(owned.dispose).not.toHaveBeenCalled();

    first.release();
    await firstNotification;
    expect(completed).toBe(false);
    expect(owned.resource.meta.doc).toBe(owned.document);
    expect(owned.dispose).not.toHaveBeenCalled();
    second.release();
    await disposing;
    expect(observations).toEqual(['download', 'pending', 0, 'saveToDisk', 'pending', 0]);
    expect(completed).toBe(true);
    expect(owned.resource.meta.doc).toBeUndefined();
    expect(owned.resource.meta.statusChanges).toBeUndefined();
    expect(owned.dispose).toHaveBeenCalledTimes(1);
  });
});
