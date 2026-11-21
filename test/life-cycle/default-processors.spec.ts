import {expect, jest, test} from '@jest/globals';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {processCss} from '../../src/life-cycle/process-css.js';
import type {DownloadResource} from '../../src/life-cycle/types.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

function binaryResource(): DownloadResource {
  return {...createResource({type: ResourceType.Binary, depth: 0,
    url: 'https://example.test/page.bin', refUrl: 'https://example.test/',
    localRoot: 'output', encoding: 'utf8'}),
  body: 'a { background: url("asset.png") }'};
}

test('default binary postprocessing stays synchronous without inspecting its body or loading a parser', () => {
  const loadHtml = jest.fn(() => { throw new Error('Unexpected parser load'); });
  const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: 'output', loadHtml});
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const resource = binaryResource();
  const readBody = jest.fn(() => { throw new Error('Unexpected body access'); });
  Object.defineProperty(resource, 'body', {get: readBody});
  const submit = jest.fn();

  for (const process of options.processAfterDownload) {
    expect(process(resource, submit, options, pipeline)).toBe(resource);
  }
  expect(readBody).not.toHaveBeenCalled();
  expect(loadHtml).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

test('a preceding asynchronous hook can change which default processor runs', async () => {
  const lifeCycle = defaultLifeCycle();
  const events: string[] = [];
  let resume!: () => void;
  const ready = new Promise<void>(resolve => { resume = resolve; });
  lifeCycle.processAfterDownload.splice(lifeCycle.processAfterDownload.indexOf(processCss), 0,
    async resource => {
      events.push('mutation-start');
      await ready;
      resource.type = ResourceType.Css;
      events.push('mutation-finish');
      return resource;
    });
  lifeCycle.processAfterDownload.push(resource => {
    events.push('observer');
    return resource;
  });
  const options = defaultDownloadOptions({...lifeCycle, localRoot: 'output'});
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const resource = binaryResource();
  const children: Resource[] = [];

  const completed = pipeline.processAfterDownload(resource, resources => {
    events.push('submit');
    children.push(...(Array.isArray(resources) ? resources : [resources]));
  });
  const beforeResume = events.slice();
  resume();
  expect(await completed).toBe(resource);

  expect(beforeResume).toEqual(['mutation-start']);
  expect(events).toEqual(['mutation-start', 'mutation-finish', 'submit', 'observer']);
  expect(resource.meta.cssProcessed).toBe(1);
  expect(children.map(child => child.url)).toEqual(['https://example.test/asset.png']);
});
