import {expect, test} from '@jest/globals';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

const parent = () => createResource({type: ResourceType.Css, depth: 0,
  url: 'https://example.test/docs/style.css', refUrl: 'https://example.test/', localRoot: 'output'});

test('combined link processing keeps its Promise contract with synchronous hooks', async () => {
  const options = defaultDownloadOptions(defaultLifeCycle());
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const result = pipeline.createAndProcessResource('../asset.png', ResourceType.Binary, 1, null, parent());
  expect(result).toBeInstanceOf(Promise);
  expect((await result)?.url).toBe('https://example.test/asset.png');
});

test('combined link processing preserves mixed hook ordering and transformations', async () => {
  const events: string[] = [];
  const options = defaultDownloadOptions({...defaultLifeCycle(),
    linkRedirect: [url => { events.push('redirect'); return url + '?q=1'; }],
    detectResourceType: [async (_url, type) => { events.push('detect'); return type; }],
    generateSavePath: [async path => { events.push('path'); return path; }],
    processBeforeDownload: [resource => { events.push('before'); return resource; },
      async resource => { events.push('async-before'); resource.meta.checked = true; return resource; }]
  });
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const result = await pipeline.createAndProcessResource('../asset.png', ResourceType.Binary, 1, null, parent());
  expect(result?.meta.checked).toBe(true);
  expect(result?.downloadLink).toBe('https://example.test/asset.png?q=1');
  expect(events).toEqual(['redirect', 'detect', 'path', 'before', 'async-before']);
});

test('combined link processing stops after cancellation in a synchronous hook', async () => {
  const controller = new AbortController();
  let detected = false;
  const options = defaultDownloadOptions({...defaultLifeCycle(),
    linkRedirect: [url => { controller.abort(new Error('cancelled')); return url; }],
    detectResourceType: [(_url, type) => { detected = true; return type; }]
  });
  const pipeline = new PipelineExecutorImpl(options, options.req, options, controller.signal);
  await expect(pipeline.createAndProcessResource('asset.png', ResourceType.Binary, 1, null, parent()))
    .rejects.toThrow('cancelled');
  expect(detected).toBe(false);
});

test('SVG link processing preserves asynchronous hooks and discarded links', async () => {
  const options = defaultDownloadOptions({...defaultLifeCycle(),
    linkRedirect: [async url => url === 'skip.png' ? undefined : url],
    detectResourceType: [async (_url, type) => type],
    generateSavePath: [async path => path],
    processBeforeDownload: [async resource => { resource.replacePath = 'saved/' + resource.rawUrl; return resource; }]
  });
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const resource = {...parent(), type: ResourceType.Svg as const,
    body: '<svg xmlns="http://www.w3.org/2000/svg"><image href="a.png"/><image href="skip.png"/><image href="b.png"/></svg>'};
  const submitted: Resource[] = [];
  const result = await pipeline.processAfterDownload(resource, value => {
    submitted.push(...Array.isArray(value) ? value : [value]);
  });
  expect(submitted.map(value => value.rawUrl)).toEqual(['a.png', 'b.png']);
  expect(result?.body).toContain('href="saved/a.png"');
  expect(result?.body).toContain('href="skip.png"');
  expect(result?.body).toContain('href="saved/b.png"');
});
