import {describe, expect, jest, test} from '@jest/globals';
import {createResource} from '../../src/resource.js';
import type {
  InitLifeCycleFunc,
  InitSubmitFunc,
  ProcessingLifeCycle
} from '../../src/life-cycle/types.js';
import {
  PipelineExecutorImpl
} from '../../src/downloader/pipeline-executor-impl.js';
import {AbstractDownloader} from '../../src/downloader/main.js';
import {defaultDownloadOptions, mergeOverrideOptions} from '../../src/options.js';
import type {DownloadOptions, StaticDownloadOptions} from '../../src/options.js';

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
  init: InitLifeCycleFunc[] = []
): ProcessingLifeCycle {
  return {
    init,
    linkRedirect: [],
    detectResourceType: [],
    createResource,
    processBeforeDownload: [],
    download: [],
    processAfterDownload: [],
    saveToDisk: [],
    dispose: [],
    statusChange: []
  };
}

function makeInitialDownloader(options: DownloadOptions, accepted: string[]): AbstractDownloader {
  const downloader = Object.create(AbstractDownloader.prototype) as AbstractDownloader;
  downloader._options = options;
  downloader._pipeline = new PipelineExecutorImpl(options, options.req, options);
  downloader.addProcessedResource = resource => { accepted.push(resource.url); };
  return downloader;
}

describe('AbstractDownloader init submissions', () => {
  test.each(['sequential', 'concurrent'] as const)(
    'isolates initial URLs for %s downloaders reusing the same options', async mode => {
      let initialization = 0;
      const options = defaultDownloadOptions({...fakeOpt,
        ...makeLifeCycle([async (_pipeline, _downloader, submit) => {
          const run = ++initialization;
          submit?.(`https://example.com/run-${run}-before`);
          await Promise.resolve();
          submit?.(`https://example.com/run-${run}-after`);
        }]), initialUrl: ['https://example.com/original']});
      const initialUrls = options.initialUrl!;
      const firstAccepted: string[] = [], secondAccepted: string[] = [];
      const first = makeInitialDownloader(mergeOverrideOptions(options), firstAccepted);
      const second = makeInitialDownloader(mergeOverrideOptions(options), secondAccepted);
      expect(first.options).toBe(options);
      expect(second.options).toBe(options);

      if (mode === 'concurrent') {
        await Promise.all([first.addInitialResource(initialUrls), second.addInitialResource(initialUrls)]);
      } else {
        await first.addInitialResource(initialUrls);
        await second.addInitialResource(initialUrls);
      }

      expect(firstAccepted).toEqual(['https://example.com/original',
        'https://example.com/run-1-before', 'https://example.com/run-1-after']);
      expect(secondAccepted).toEqual(['https://example.com/original',
        'https://example.com/run-2-before', 'https://example.com/run-2-after']);
      expect(options.initialUrl).toBe(initialUrls);
      expect(initialUrls).toEqual(['https://example.com/original']);
    });

  test('accepts init submissions without writing to a frozen caller URL array', async () => {
    const initialUrls = ['https://example.com/original'];
    Object.freeze(initialUrls);
    const options = defaultDownloadOptions({...fakeOpt,
      ...makeLifeCycle([(_pipeline, _downloader, submit) => {
        submit?.('https://example.com/from-init');
      }])});
    const accepted: string[] = [];
    const downloader = makeInitialDownloader(options, accepted);

    await downloader.addInitialResource(initialUrls);

    expect(accepted).toEqual(['https://example.com/original', 'https://example.com/from-init']);
    expect(initialUrls).toEqual(['https://example.com/original']);
  });
});

describe('PipelineExecutorImpl.init passes submit', () => {
  test('submit is passed to init hooks', async () => {
    const received: Array<InitSubmitFunc | undefined> = [];
    const hook: InitLifeCycleFunc = (_pipeline, _downloader, submit) => {
      received.push(submit);
    };
    const lc = makeLifeCycle([hook]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const submit: InitSubmitFunc = () => {};

    await pipeline.init(pipeline, undefined, submit);

    expect(received).toStrictEqual([submit]);
  });

  test('submit is undefined when not provided', async () => {
    const received: Array<InitSubmitFunc | undefined> = [];
    const hook: InitLifeCycleFunc = (_pipeline, _downloader, submit) => {
      received.push(submit);
    };
    const lc = makeLifeCycle([hook]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);

    await pipeline.init(pipeline);

    expect(received).toStrictEqual([undefined]);
  });

  test('multiple init hooks all receive submit', async () => {
    const received: Array<InitSubmitFunc | undefined> = [];
    const hook1: InitLifeCycleFunc = (_pipeline, _downloader, submit) => {
      received.push(submit);
    };
    const hook2: InitLifeCycleFunc = (_pipeline, _downloader, submit) => {
      received.push(submit);
    };
    const lc = makeLifeCycle([hook1, hook2]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);
    const submit: InitSubmitFunc = () => {};

    await pipeline.init(pipeline, undefined, submit);

    expect(received).toStrictEqual([submit, submit]);
  });
});

describe('InitSubmitFunc pushes to urlArr', () => {
  test('submit appends URLs to the array', () => {
    const urlArr: string[] = ['https://example.com/original'];
    const submit: InitSubmitFunc = (url: string) => {
      urlArr.push(url);
    };

    submit('https://example.com/from-init-1');
    submit('https://example.com/from-init-2');

    expect(urlArr).toStrictEqual([
      'https://example.com/original',
      'https://example.com/from-init-1',
      'https://example.com/from-init-2'
    ]);
  });

  test('init hook can submit URLs via submit', async () => {
    const urlArr: string[] = [];
    const submit: InitSubmitFunc = (url: string) => {
      urlArr.push(url);
    };

    const hook: InitLifeCycleFunc = async (_pipeline, _downloader, submit) => {
      if (!submit) return;
      submit('https://example.com/a');
      submit('https://example.com/b');
    };
    const lc = makeLifeCycle([hook]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);

    await pipeline.init(pipeline, undefined, submit);

    expect(urlArr).toStrictEqual([
      'https://example.com/a',
      'https://example.com/b'
    ]);
  });

  test('async init hook can submit URLs after await', async () => {
    const urlArr: string[] = [];
    const submit: InitSubmitFunc = (url: string) => {
      urlArr.push(url);
    };

    const hook: InitLifeCycleFunc = async (_pipeline, _downloader, submit) => {
      if (!submit) return;
      // simulate async work (e.g. fetching from database)
      await Promise.resolve();
      submit('https://example.com/async');
    };
    const lc = makeLifeCycle([hook]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);

    await pipeline.init(pipeline, undefined, submit);

    expect(urlArr).toStrictEqual(['https://example.com/async']);
  });

  test('multiple hooks submit in order', async () => {
    const urlArr: string[] = ['https://example.com/initial'];
    const submit: InitSubmitFunc = (url: string) => {
      urlArr.push(url);
    };

    const hook1: InitLifeCycleFunc = async (_p, _d, submit) => {
      if (!submit) return;
      submit('https://example.com/hook1-a');
      submit('https://example.com/hook1-b');
    };
    const hook2: InitLifeCycleFunc = async (_p, _d, submit) => {
      if (!submit) return;
      submit('https://example.com/hook2');
    };
    const lc = makeLifeCycle([hook1, hook2]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);

    await pipeline.init(pipeline, undefined, submit);

    expect(urlArr).toStrictEqual([
      'https://example.com/initial',
      'https://example.com/hook1-a',
      'https://example.com/hook1-b',
      'https://example.com/hook2'
    ]);
  });

  test('hook without submit parameter still works', async () => {
    const urlArr: string[] = [];
    const submit: InitSubmitFunc = (url: string) => {
      urlArr.push(url);
    };

    // old-style hook that ignores the third parameter
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const hook: InitLifeCycleFunc = async (_pipeline, _downloader) => {
      // setup work, no submit
    };
    const lc = makeLifeCycle([hook]);
    const pipeline = new PipelineExecutorImpl(lc, {}, fakeOpt);

    await pipeline.init(pipeline, undefined, submit);

    expect(urlArr).toStrictEqual([]);
  });
});
