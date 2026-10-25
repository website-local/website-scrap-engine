import {describe, expect, jest, test} from '@jest/globals';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';
import type {
  DownloadResource,
  ProcessingLifeCycle,
  ResourceStatus,
  StatusChangeFunc
} from '../../src/life-cycle/types.js';
import {
  PipelineExecutorImpl
} from '../../src/downloader/pipeline-executor-impl.js';
import type {StaticDownloadOptions} from '../../src/options.js';
import {defaultStatusListener} from '../../src/life-cycle/default-status-listener.js';
import {createDefaultLogger} from '../../src/logger/default-logger.js';

const fakeOpt = {
  concurrency: 1,
  encoding: {},
  localRoot: 'root',
  maxDepth: 5,
  meta: {}
} as StaticDownloadOptions;

function makeLifeCycle(
  statusChange: StatusChangeFunc[] = []
): ProcessingLifeCycle {
  return {
    init: [],
    linkRedirect: [],
    detectResourceType: [],
    generateSavePath: [],
    createResource,
    processBeforeDownload: [],
    download: [],
    processAfterDownload: [],
    saveToDisk: [],
    dispose: [],
    statusChange
  };
}

function makeResource(url?: string): Resource {
  return createResource({
    type: ResourceType.Html,
    depth: 1,
    url: url ?? 'https://example.com/page',
    refUrl: 'https://example.com/',
    localRoot: 'root',
    encoding: 'utf8'
  });
}

describe('PipelineExecutorImpl.notifyStatusChange', () => {
  test('calls all listeners with correct arguments', async () => {
    const listener1 = jest.fn<StatusChangeFunc>();
    const listener2 = jest.fn<StatusChangeFunc>();
    const lc = makeLifeCycle([listener1, listener2]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    await pipeline.notifyStatusChange(res, 'download');

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener1).toHaveBeenCalledWith(res, 'download', fakeOpt, pipeline);
    expect(listener2).toHaveBeenCalledWith(res, 'download', fakeOpt, pipeline);
  });

  test('all listeners run even if one throws', async () => {
    const listener1 = jest.fn<StatusChangeFunc>().mockImplementation(() => {
      throw new Error('boom');
    });
    const listener2 = jest.fn<StatusChangeFunc>();
    const lc = makeLifeCycle([listener1, listener2]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    // should not throw
    await pipeline.notifyStatusChange(res, 'error');

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
  });

  test('awaits listeners returning promises', async () => {
    let resolved = false;
    const asyncListener = jest.fn<StatusChangeFunc>().mockImplementation(
      () => new Promise<void>(r => {
        setTimeout(() => { resolved = true; r(); }, 10);
      })
    );
    const lc = makeLifeCycle([asyncListener]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    await pipeline.notifyStatusChange(res, 'saveToDisk');

    expect(resolved).toBe(true);
    expect(asyncListener).toHaveBeenCalledTimes(1);
  });

  test('swallows rejected promise from listener', async () => {
    const asyncListener = jest.fn<StatusChangeFunc>().mockImplementation(
      () => Promise.reject(new Error('async boom'))
    );
    const syncListener = jest.fn<StatusChangeFunc>();
    const lc = makeLifeCycle([asyncListener, syncListener]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    await pipeline.notifyStatusChange(res, 'processAfterDownload');

    expect(asyncListener).toHaveBeenCalledTimes(1);
    expect(syncListener).toHaveBeenCalledTimes(1);
  });

  test('no-op when statusChange array is empty', async () => {
    const lc = makeLifeCycle([]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    // should complete without error
    await pipeline.notifyStatusChange(res, 'dispose');
  });

  test('passes each ResourceStatus type correctly', async () => {
    const statuses: ResourceStatus[] = [];
    const listener = jest.fn<StatusChangeFunc>().mockImplementation(
      (_res, status) => { statuses.push(status); }
    );
    const lc = makeLifeCycle([listener]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const res = makeResource();

    const allStatuses: ResourceStatus[] = [
      'createResource', 'processBeforeDownload', 'download',
      'processAfterDownload', 'saveToDisk', 'error', 'dispose'
    ];
    for (const s of allStatuses) {
      await pipeline.notifyStatusChange(res, s);
    }

    expect(statuses).toStrictEqual(allStatuses);
  });
});

describe('defaultLifeCycle includes statusChange', () => {
  test('statusChange array is non-empty', async () => {
    const {defaultLifeCycle} =
      await import('../../src/life-cycle/default-life-cycle.js');
    const lc = defaultLifeCycle();
    expect(Array.isArray(lc.statusChange)).toBe(true);
    expect(lc.statusChange.length).toBeGreaterThan(0);
  });
});

describe('defaultStatusListener', () => {
  test.each(['download', 'processAfterDownload', 'saveToDisk'] as const)(
    'logs %s through its pipeline logger', async status => {
      const log = jest.fn();
      const logger = {...createDefaultLogger(), debug: log, warn: log};
      const pipeline = new PipelineExecutorImpl(makeLifeCycle([defaultStatusListener]), {}, fakeOpt, undefined, logger);
      const res = makeResource();
      await pipeline.notifyStatusChange(res, status);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toBe('system.skip');
      expect(log.mock.calls[0]).toContain(res.url);
    });

  test.each([
    {error: {name: 'HTTPError', response: {statusCode: 404}}, category: 'io.http.notFound'},
    {error: {name: 'LocalUrlMountNotFoundError', statusCode: 404}, category: 'io.http.notFound'},
    {error: new Error('something broke'), category: 'system.error'},
    {error: null, category: 'system.error'}
  ])('logs $category errors through the owning pipeline', async ({error, category}) => {
    const log = jest.fn();
    const logger = {...createDefaultLogger(), error: log};
    const pipeline = new PipelineExecutorImpl(makeLifeCycle([defaultStatusListener]), {}, fakeOpt, undefined, logger);
    const res = makeResource();
    res.meta.errorCause = 'downloading resource';
    res.meta.error = error;
    await pipeline.notifyStatusChange(res, 'error');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(category);
    expect(log.mock.calls[0]).toContain(res.url);
  });

  test.each(['dispose', 'createResource', 'processBeforeDownload'] as const)(
    'keeps %s silent', async status => {
      const log = jest.fn();
      const logger = {...createDefaultLogger(), trace: log, debug: log, info: log, warn: log, error: log};
      const pipeline = new PipelineExecutorImpl(makeLifeCycle([defaultStatusListener]), {}, fakeOpt, undefined, logger);
      await pipeline.notifyStatusChange(makeResource(), status);
      expect(log).not.toHaveBeenCalled();
    });
});

describe('downloader integration with statusChange', () => {
  test('handleError sets meta and notifies', async () => {
    const listener = jest.fn<StatusChangeFunc>();
    const lc = makeLifeCycle([listener]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);

    const res = makeResource();
    const err = new Error('test error');

    // simulate what AbstractDownloader.handleError does
    res.meta = res.meta || {};
    res.meta['error'] = err;
    res.meta['errorCause'] = 'downloading resource';
    await pipeline.notifyStatusChange(res, 'error');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(res, 'error', fakeOpt, pipeline);
  });

  test('download discard notifies with download status', async () => {
    const listener = jest.fn<StatusChangeFunc>();
    const lc = makeLifeCycle([listener]);
    // download returns undefined = discarded
    lc.download = [() => undefined];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);

    const res = makeResource();
    const result = await pipeline.download(res);
    expect(result).toBeUndefined();

    // simulate what SingleThreadDownloader does on discard
    await pipeline.notifyStatusChange(res, 'download');

    expect(listener).toHaveBeenCalledWith(res, 'download', fakeOpt, pipeline);
  });

  test('processAfterDownload discard notifies', async () => {
    const listener = jest.fn<StatusChangeFunc>();
    const lc = makeLifeCycle([listener]);
    lc.processAfterDownload = [() => undefined];
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);

    const res = makeResource();
    res.body = '<html></html>';
    const result = await pipeline.processAfterDownload(
      res as DownloadResource, () => {});
    expect(result).toBeUndefined();

    await pipeline.notifyStatusChange(res, 'processAfterDownload');

    expect(listener).toHaveBeenCalledWith(
      res, 'processAfterDownload', fakeOpt, pipeline);
  });
});
