import {describe, expect, jest, test} from '@jest/globals';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import type {DownloadResource} from '../../src/life-cycle/types.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

const stages = ['download', 'processAfterDownload', 'saveToDisk'] as const;
type Stage = typeof stages[number];
type Hook = <T extends Resource>(res: T) => T;

function setup(stage: Stage, hooks: Hook[], limit = 4) {
  const lifeCycle = defaultLifeCycle();
  lifeCycle[stage] = hooks;
  const options = defaultDownloadOptions({...lifeCycle, maxResourceBytes: limit});
  const logger = {trace() {}, debug() {}, info() {}, warn: jest.fn(), error: jest.fn(), isTraceEnabled: () => false};
  const pipeline = new PipelineExecutorImpl(options, options.req, options, undefined, logger);
  const resource = createResource({type: ResourceType.Binary, depth: 0,
    url: 'https://example.test/body', refUrl: 'https://example.test/', localRoot: 'output', encoding: 'utf8'});
  resource.body = '';
  const run = () => {
    if (stage === 'processAfterDownload') {
      return pipeline.processAfterDownload(resource as DownloadResource, () => {});
    }
    if (stage === 'saveToDisk') return pipeline.saveToDisk(resource as DownloadResource);
    return pipeline.download(resource);
  };
  return {resource, run, logger};
}

describe.each(stages)('%s input limits', stage => {
  test.each(['entry', 'hook'])('discards an oversized body at %s before the next hook', async boundary => {
    const next = jest.fn(<T extends Resource>(res: T) => res);
    const {resource, run, logger} = setup(stage, [res => { res.body = '😀'; return res; }, next], 3);
    if (boundary === 'entry') resource.body = '😀';
    await expect(run()).resolves.toBeUndefined();
    expect(resource.shouldBeDiscardedFromDownload).toBe(true);
    expect(resource.meta).toMatchObject({resourceSize: 4, resourceSizeLimit: 3});
    expect(resource.meta.error).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('accepts a body at the exact byte limit', async () => {
    const {resource, run, logger} = setup(stage, [res => { res.body = '😀'; return res; }]);
    expect(await run()).toBe(resource);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe.each(['processAfterDownload', 'saveToDisk'] as const)('%s hook mutations', stage => {
  test.each(['body', 'encoding'])('checks %s changes on the same resource', async change => {
    const next = jest.fn(<T extends Resource>(res: T) => res);
    const {resource, run} = setup(stage, [res => {
      if (change === 'body') res.body = '😀';
      else res.encoding = 'utf8';
      return res;
    }, next], 3);
    resource.body = change === 'body' ? Buffer.from([1, 2]) : 'éé';
    resource.encoding = change === 'body' ? 'utf8' : 'latin1';
    expect(await run()).toBeUndefined();
    expect(resource.meta).toMatchObject({resourceSize: 4, resourceSizeLimit: 3});
    expect(next).not.toHaveBeenCalled();
  });
});

test('download accepts an empty body returned for an undefined body', async () => {
  const {resource, run} = setup('download', [res => { res.body = ''; return res; }]);
  resource.body = undefined;
  expect(await run()).toBe(resource);
});
