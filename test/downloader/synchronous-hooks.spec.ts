import {expect, test} from '@jest/globals';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {defaultDownloadOptions} from '../../src/options.js';

test('mixed synchronous and asynchronous hooks preserve order and short-circuit', async () => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const events: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  options.linkRedirect = [
    url => { events.push('first'); return url + '/first'; },
    async url => { events.push('waiting'); await waiting; return url + '/second'; },
    url => { events.push(url); return undefined; },
    () => { throw new Error('must not execute'); }
  ];
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const result = pipeline.linkRedirect('https://example.org', null, null);
  expect(events).toEqual(['first', 'waiting']);
  release();
  expect(await result).toBeUndefined();
  expect(events).toEqual(['first', 'waiting', 'https://example.org/first/second']);
  options.linkRedirect = [url => url + '/sync'];
  expect(pipeline.linkRedirect('https://example.org', null, null)).toBe('https://example.org/sync');
});

test('cancellation after an asynchronous hook prevents the next hook', async () => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const controller = new AbortController();
  options.linkRedirect = [
    async url => { controller.abort(new Error('cancelled')); return url; },
    () => { throw new Error('must not execute'); }
  ];
  const pipeline = new PipelineExecutorImpl(options, options.req, options, controller.signal);
  await expect(pipeline.linkRedirect('https://example.org', null, null)).rejects.toThrow('cancelled');
});
