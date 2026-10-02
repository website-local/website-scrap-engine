import {describe, expect, jest, test} from '@jest/globals';
import {BufferBudget} from '../../src/buffer-budget.js';
import type {BufferAccount} from '../../src/buffer-budget.js';
import {withCrawlContext} from '../../src/crawl-context.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import type {DownloadResource} from '../../src/life-cycle/types.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

const stages = ['download', 'processAfterDownload', 'saveToDisk'] as const;
type Stage = typeof stages[number];
type Hook = <T extends Resource>(res: T) => T;
const logger = {trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false};

function setup(stage: Stage, hooks: Hook[], limit = 4) {
  const lifeCycle = defaultLifeCycle();
  lifeCycle[stage] = hooks;
  const options = defaultDownloadOptions({...lifeCycle, maxResourceBytes: limit, maxBufferedBytes: limit});
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const resource = createResource({type: ResourceType.Binary, depth: 0,
    url: 'https://example.test/body', refUrl: 'https://example.test/', localRoot: 'output', encoding: 'utf8'});
  resource.body = '';
  const run = (bufferAccount: BufferAccount) => withCrawlContext({
    logger, signal: new AbortController().signal, bufferAccount
  }, () => {
    if (stage === 'processAfterDownload') {
      return pipeline.processAfterDownload(resource as DownloadResource, () => {});
    }
    if (stage === 'saveToDisk') return pipeline.saveToDisk(resource as DownloadResource);
    return pipeline.download(resource);
  });
  return {resource, run};
}

describe.each(stages)('%s body accounting', stage => {
  test.each(['entry', 'hook'])('resource limit precedes budget failure at %s', async boundary => {
    const next = jest.fn(<T extends Resource>(res: T) => res);
    const {resource, run} = setup(stage, [res => { res.body = '😀'; return res; }, next], 3);
    if (boundary === 'entry') resource.body = '😀';
    const budget = new BufferBudget(3);
    const account = budget.reserve(0);
    await expect(run(account)).rejects.toMatchObject({code: 'ERR_RESOURCE_SIZE_LIMIT', actual: 4, limit: 3});
    expect(budget.used).toBe(0);
    expect(next).not.toHaveBeenCalled();
    account.release();
  });

  test('waits for asynchronous accounting before invoking hooks and completing', async () => {
    let acknowledge!: () => void;
    const waiting = new Promise<void>(resolve => { acknowledge = resolve; });
    const events: string[] = [];
    const {resource, run} = setup(stage, [res => { events.push('hook'); res.body = '😀'; return res; }]);
    const result = run({reserveChild() {}, observeBody(bytes) {
      events.push(`observe ${bytes}`);
      return waiting.then(() => { events.push(`ack ${bytes}`); });
    }}).then(value => { events.push('complete'); return value; });
    // saveToDisk first awaits its separate save-policy check.
    await Promise.resolve();
    expect(events).toEqual(['observe 0']);
    acknowledge();
    expect(await result).toBe(resource);
    expect(events).toEqual(['observe 0', 'ack 0', 'hook', 'observe 4', 'ack 4', 'complete']);
  });

  test('propagates an asynchronous budget rejection before the next hook', async () => {
    const next = jest.fn(<T extends Resource>(res: T) => res);
    const {run} = setup(stage, [next]);
    const failure = new Error('parent rejected accounting');
    await expect(run({reserveChild() {}, observeBody: () => Promise.reject(failure)})).rejects.toBe(failure);
    expect(next).not.toHaveBeenCalled();
  });
});

describe.each(['processAfterDownload', 'saveToDisk'] as const)('%s hook mutations', stage => {
  test.each(['body', 'encoding'])('recalculates %s changes on the same resource', async change => {
    const budget = new BufferBudget(4);
    const account = budget.reserve(0);
    const {resource, run} = setup(stage, [res => {
      expect(budget.used).toBe(2);
      if (change === 'body') res.body = '😀';
      else res.encoding = 'utf8';
      return res;
    }, res => {
      expect(budget.used).toBe(4);
      res.body = Buffer.from([1, 2, 3]);
      return res;
    }, res => {
      // Shrinking the body preserves its high-water reservation.
      expect(budget.used).toBe(4);
      res.body = '';
      return res;
    }]);
    resource.body = change === 'body' ? Buffer.from([1, 2]) : 'éé';
    resource.encoding = 'latin1';
    if (change === 'body') resource.encoding = 'utf8';
    expect(await run(account)).toBe(resource);
    expect(budget.used).toBe(4);
    account.release();
    expect(budget.used).toBe(0);
  });
});

test('download accounts undefined and empty bodies without consuming credits', async () => {
  const {resource, run} = setup('download', [res => { res.body = ''; return res; }]);
  resource.body = undefined;
  const observed: number[] = [];
  expect(await run({reserveChild() {}, observeBody(bytes) { observed.push(bytes); }})).toBe(resource);
  expect(observed).toEqual([0, 0]);
});
