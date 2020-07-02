import {
  createResource,
  prepareResourceForClone,
  Resource,
  ResourceType
} from '../src/resource';
import path from 'path';

describe('resource', function () {
  test('html-to-html-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/buffer.html#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays.html',
      '/tmp/aaa');
    expect(resource).toBeTruthy();
    expect(resource.type).toBe(ResourceType.Html);
    expect(resource.depth).toBe(1);
    expect(resource.rawUrl).toBe(
      'http://nodejs.cn/api/buffer.html#buffer_buffers_and_typedarrays');
    expect(resource.replacePath).toBe('../buffer.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn\\api\\buffer.html'));
  });
  test('path-to-html-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/buffer.html#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('../buffer.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/buffer.html'));
  });
  test('html-to-path-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/buffer#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays.html',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('../buffer.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/buffer.html'));
  });
  test('html-to-index-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays.html',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('../index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/index.html'));
  });
  test('index-to-index-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/buffer/',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('../index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/index.html'));
  });
  test('path-to-path-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/buffer#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('../buffer.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/buffer.html'));
  });
  test('html-self-link-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/buffer.html#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/buffer.html',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/buffer.html'));
  });
  test('htm-self-link-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/buffer.htm#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/buffer.htm',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/buffer.html'));
  });
  test('path-self-link-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/buffer#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/buffer',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/buffer.html'));
  });
  test('path-index-self-link-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/index.html'));
  });
  test('cross-host-link-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.com/api/#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/',
      '/tmp/aaa');
    expect(resource.replacePath).toBe(
      '../../nodejs.com/api/index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.com/api/index.html'));
  });
  test('cross-host-link-resource-with-different-protocol', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'https://nodejs.com/api/#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/',
      '/tmp/aaa');
    expect(resource.replacePath).toBe(
      '../../nodejs.com/api/index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.com/api/index.html'));
  });
  test('cross-host-link-resource-with-no-protocol', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      '//nodejs.com/api/#buffer_buffers_and_typedarrays',
      'https://nodejs.cn/api/',
      '/tmp/aaa');
    expect(resource.replacePath).toBe(
      '../../nodejs.com/api/index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.com/api/index.html'));
  });
  test('relative-link', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      '#buffer_buffers_and_typedarrays',
      'https://nodejs.com/api/',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.com/api/index.html'));
  });
  test('same-site-absolute-link', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      '/#buffer_buffers_and_typedarrays',
      'https://nodejs.com/api/',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('../index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.com/index.html'));
  });
  test('prepare-resource-for-clone', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      '/#buffer_buffers_and_typedarrays',
      'https://nodejs.com/api/',
      '/tmp/aaa');
    const expected: Resource = {
      type: 2,
      depth: 1,
      encoding: 'utf8',
      url: 'https://nodejs.com/#buffer_buffers_and_typedarrays',
      rawUrl: '/#buffer_buffers_and_typedarrays',
      downloadLink: 'https://nodejs.com/',
      refUrl: 'https://nodejs.com/api/',
      savePath: 'nodejs.com\\index.html',
      localRoot: '/tmp/aaa',
      replacePath: '../index.html#buffer_buffers_and_typedarrays',
      createTimestamp: resource.createTimestamp,
      body: undefined,
      meta: {},
      host: 'nodejs.com'
    };
    expect(prepareResourceForClone(resource)).toEqual(expected);
    resource.body = expected.body = new Uint8Array(12);
    expect(prepareResourceForClone(resource)).toEqual(expected);
    resource.body = expected.body = new ArrayBuffer(24);
    expect(prepareResourceForClone(resource)).toEqual(expected);
    resource.body = expected.body = Math.random().toString(36);
    expect(prepareResourceForClone(resource)).toEqual(expected);
    resource.body = expected.body = Buffer.alloc(7);
    expect(prepareResourceForClone(resource)).toEqual(expected);
    resource.meta = {
      headers: {aaa: 'bbb', ccc: 'ddd'},
      testObj1: {},
      testArr1: [1, 3, 5],
      testStr: ''
    };
    expected.meta = {
      headers: {aaa: 'bbb', ccc: 'ddd'},
      testStr: ''
    };
    expect(prepareResourceForClone(resource)).toEqual(expected);
  });
});
