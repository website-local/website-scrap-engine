import {describe, expect, jest, test} from '@jest/globals';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';
import type {DownloadResource} from '../../src/life-cycle/types.js';

const stages = ['processBeforeDownload', 'download', 'processAfterDownload', 'saveToDisk'] as const;
type Stage = typeof stages[number];

async function invoke(pipeline: PipelineExecutorImpl, stage: Stage, resource: Resource) {
  if (stage === 'processBeforeDownload') return pipeline.processBeforeDownload(resource, null, null);
  if (stage === 'processAfterDownload') {
    return pipeline.processAfterDownload(resource as DownloadResource, () => {});
  }
  if (stage === 'saveToDisk') return pipeline.saveToDisk(resource as DownloadResource);
  return pipeline.download(resource);
}

function makeResource(stage: Stage): Resource {
  return {...createResource({type: ResourceType.Binary, depth: 0,
    url: 'https://original.test/a', refUrl: 'https://original.test/', localRoot: 'output'}),
  body: stage === 'download' ? undefined : 'body'};
}

describe.each(stages)('%s resource invariants', stage => {
  test.each([false, true])('normalizes every hook result (cloned: %s)', async clone => {
    const lifeCycle = defaultLifeCycle();
    const observed = jest.fn();
    const mutate = <T extends Resource>(resource: T): T => {
      const result = clone ? structuredClone(resource) : resource;
      result.url = 'https://changed.test/b';
      result.refUrl = 'https://ref.test/c';
      result.replacePath = '../changed.bin';
      return result;
    };
    const inspect = <T extends Resource>(resource: T): T => {
      expect(resource.uri.clone().toString()).toBe(resource.url);
      expect(resource.refUri.clone().toString()).toBe(resource.refUrl);
      expect(resource.replaceUri.clone().toString()).toBe(resource.replacePath);
      expect(resource.host).toBe('changed.test');
      observed();
      return resource;
    };
    lifeCycle[stage] = [mutate, inspect];
    const options = defaultDownloadOptions({...lifeCycle, localRoot: 'output'});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    await invoke(pipeline, stage, makeResource(stage));
    expect(observed).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed hook results before calling the next hook', async () => {
    const lifeCycle = defaultLifeCycle();
    const next = jest.fn(<T extends Resource>(resource: T) => resource);
    lifeCycle[stage] = [<T extends Resource>(resource: T): T =>
      ({...resource, refUrl: undefined} as unknown as T), next];
    const options = defaultDownloadOptions({...lifeCycle, localRoot: 'output'});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    await expect(invoke(pipeline, stage, makeResource(stage)))
      .rejects.toThrow('Resource.refUrl must be a string');
    expect(next).not.toHaveBeenCalled();
  });
});
