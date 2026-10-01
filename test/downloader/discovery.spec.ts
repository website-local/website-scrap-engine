import {expect, test} from '@jest/globals';
import {createDiscoverySubmit} from '../../src/downloader/discovery.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

const resource = () => createResource({type: ResourceType.Binary, depth: 0,
  url: 'https://example.test/child', refUrl: 'https://example.test/', localRoot: 'output'});

test('discovery bounds repeated and batched submissions before invoking the consumer', () => {
  const accepted: Resource[] = [];
  const discovery = createDiscoverySubmit(res => { accepted.push(res); }, new AbortController().signal, 2);
  discovery.submit(resource());
  expect(() => discovery.submit([resource(), resource(), resource()]))
    .toThrow(expect.objectContaining({code: 'ERR_DISCOVERY_LIMIT', limit: 2, actual: 3}));
  expect(accepted).toHaveLength(2);
  expect(() => discovery.submit(resource())).toThrow('maxDiscoveredResources');
  expect(accepted).toHaveLength(2);
});

test('closed or cancelled parents cannot submit late discoveries', () => {
  const controller = new AbortController();
  let accepted = 0;
  const discovery = createDiscoverySubmit(() => { ++accepted; }, controller.signal);
  discovery.close();
  expect(() => discovery.submit(resource())).toThrow('closed');
  const next = createDiscoverySubmit(() => { ++accepted; }, controller.signal);
  controller.abort(new Error('cancelled'));
  expect(() => next.submit(resource())).toThrow('cancelled');
  expect(accepted).toBe(0);
});

test('oversized discovered bodies are rejected before transport or queue admission', () => {
  let accepted = 0;
  const discovery = createDiscoverySubmit(() => { ++accepted; }, new AbortController().signal, 2, 3);
  expect(() => discovery.submit({...resource(), body: Buffer.alloc(4)}))
    .toThrow(expect.objectContaining({code: 'ERR_RESOURCE_SIZE_LIMIT'}));
  expect(accepted).toBe(0);
});
