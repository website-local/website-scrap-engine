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
// noinspection ES6PreferShortImport
import type {PipelineExecutor} from '../../src/life-cycle/pipeline-executor.js';

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
    // dynamic import to avoid log4js mock issues
    const {defaultLifeCycle} =
      await import('../../src/life-cycle/default-life-cycle.js');
    const lc = defaultLifeCycle();
    expect(Array.isArray(lc.statusChange)).toBe(true);
    expect(lc.statusChange.length).toBeGreaterThan(0);
  });
});

describe('defaultStatusListener', () => {
  test('handles download status', async () => {
    const {defaultStatusListener} =
      await import('../../src/life-cycle/default-status-listener.js');
    const res = makeResource();
    // should not throw
    defaultStatusListener(
      res, 'download', fakeOpt, {} as PipelineExecutor);
  });

  test('handles processAfterDownload status', async () => {
    const {defaultStatusListener} =
      await import('../../src/life-cycle/default-status-listener.js');
    const res = makeResource();
    defaultStatusListener(
      res, 'processAfterDownload', fakeOpt, {} as PipelineExecutor);
  });

  test('handles saveToDisk status', async () => {
    const {defaultStatusListener} =
      await import('../../src/life-cycle/default-status-listener.js');
    const res = makeResource();
    defaultStatusListener(
      res, 'saveToDisk', fakeOpt, {} as PipelineExecutor);
  });

  test('handles error status with HTTPError 404', async () => {
    const {defaultStatusListener} =
      await import('../../src/life-cycle/default-status-listener.js');
    const res = makeResource();
    res.meta['errorCause'] = 'downloading resource';
    res.meta['error'] = {
      name: 'HTTPError',
      response: {statusCode: 404}
    };
    defaultStatusListener(
      res, 'error', fakeOpt, {} as PipelineExecutor);
  });

  test('handles error status with generic error', async () => {
    const {defaultStatusListener} =
      await import('../../src/life-cycle/default-status-listener.js');
    const res = makeResource();
    res.meta['errorCause'] = 'post-process';
    res.meta['error'] = new Error('something broke');
    defaultStatusListener(
      res, 'error', fakeOpt, {} as PipelineExecutor);
  });

  test('handles error status with null error', async () => {
    const {defaultStatusListener} =
      await import('../../src/life-cycle/default-status-listener.js');
    const res = makeResource();
    res.meta['errorCause'] = 'unknown';
    res.meta['error'] = null;
    defaultStatusListener(
      res, 'error', fakeOpt, {} as PipelineExecutor);
  });

  test('handles dispose status', async () => {
    const {defaultStatusListener} =
      await import('../../src/life-cycle/default-status-listener.js');
    const res = makeResource();
    defaultStatusListener(
      res, 'dispose', fakeOpt, {} as PipelineExecutor);
  });

  test('handles createResource status', async () => {
    const {defaultStatusListener} =
      await import('../../src/life-cycle/default-status-listener.js');
    const res = makeResource();
    defaultStatusListener(
      res, 'createResource', fakeOpt, {} as PipelineExecutor);
  });

  test('handles processBeforeDownload status', async () => {
    const {defaultStatusListener} =
      await import('../../src/life-cycle/default-status-listener.js');
    const res = makeResource();
    defaultStatusListener(
      res, 'processBeforeDownload', fakeOpt, {} as PipelineExecutor);
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
