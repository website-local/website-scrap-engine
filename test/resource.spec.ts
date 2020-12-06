import {
  createResource,
  normalizeResource,
  prepareResourceForClone,
  RawResource,
  Resource,
  ResourceType
} from '../src/resource';
import path from 'path';
import URI = require('urijs');

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
    expect(resource.savePath).toBe(path.join('nodejs.cn', 'api', 'buffer.html'));
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

  test('path-to-html-resource-not-keeping-search', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/buffer.html?page=1#aaa',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      '/tmp/aaa');
    expect(resource.replacePath).toBe('../buffer.html?page=1#aaa');
    expect(resource.url).toBe('http://nodejs.cn/api/buffer.html#aaa');
    expect(resource.uri?.toString()).toBe(resource.url);
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/buffer.html'));
  });
  test('path-to-html-resource-with-search', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/buffer.html?page=1#aaa',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      '/tmp/aaa', 'utf8', true);
    expect(resource.replacePath).toBe('../buffer_page=1.html#aaa');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/buffer_page=1.html'));
  });
  test('path-to-html-resource-with-multi-search', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/buffer.html?page=1&a=b&page=2#aaa',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      '/tmp/aaa', 'utf8', true);
    expect(resource.replacePath).toBe(
      '../buffer_a=b_page=1_page=2.html#aaa');
    expect(resource.savePath).toBe(path.normalize(
      'nodejs.cn/api/buffer_a=b_page=1_page=2.html'));
  });
  test('path-to-index-resource-with-search', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/?page=1#aaa',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      '/tmp/aaa', 'utf8', true);
    expect(resource.replacePath).toBe('../index_page=1.html#aaa');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/index_page=1.html'));
  });
  test('css-resource-with-search', () => {
    const resource: Resource = createResource(ResourceType.Css, 1,
      'http://nodejs.cn/api/api.css?page=1#aaa',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      '/tmp/aaa', 'utf8', true);
    expect(resource.replacePath).toBe('../api_page=1.css#aaa');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/api_page=1.css'));
  });
  test('no-ext-resource-with-search', () => {
    const resource: Resource = createResource(ResourceType.Binary, 1,
      'http://nodejs.cn/api/api?page=1#aaa',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      '/tmp/aaa', 'utf8', true);
    expect(resource.replacePath).toBe('../api_page=1#aaa');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/api_page=1'));
  });
  test('path-to-index-resource-with-long-search', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/?page=1' + 'a'.repeat(1000) + '#aaa',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      '/tmp/aaa', 'utf8', true);
    expect(resource.replacePath).toBe(
      '../index_g6rVCvz2dtFaE2fbrIJTGyzhYtGRYC-6EJAwoGeLm-Q.html#aaa');
    expect(resource.savePath).toBe(path.normalize(
      'nodejs.cn/api/index_g6rVCvz2dtFaE2fbrIJTGyzhYtGRYC-6EJAwoGeLm-Q.html'));
  });
  test('index-to-index-resource-with-search', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/?page=1#aaa',
      'http://nodejs.cn/api/buffer/',
      '/tmp/aaa', 'utf8', true);
    expect(resource.replacePath).toBe('../index_page=1.html#aaa');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/index_page=1.html'));
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
      savePath: path.join('nodejs.com', 'index.html'),
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
  test('normalize-resource', () => {
    const rawResource: RawResource = {
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
      createTimestamp: Date.now(),
      body: undefined,
      meta: {}
    };
    const normalized: Resource = normalizeResource(rawResource);
    // this should not copy
    expect(normalized).toBe(rawResource);
    expect(normalized.uri).toStrictEqual(URI(normalized.url));
    expect(normalized.refUri).toStrictEqual(URI(normalized.refUrl));
    expect(normalized.replaceUri).toStrictEqual(URI(normalized.replacePath));
    expect(normalized.host).toStrictEqual(URI(normalized.url).hostname());
    rawResource.downloadStartTimestamp = Date.now();
    normalizeResource(rawResource);
    expect(normalized.waitTime).toBe(
      rawResource.downloadStartTimestamp - rawResource.createTimestamp);
    rawResource.finishTimestamp = Date.now();
    normalizeResource(rawResource);
    expect(normalized.downloadTime).toBe(
      rawResource.finishTimestamp - rawResource.downloadStartTimestamp);
    rawResource.body = Math.random().toString(36);
    normalizeResource(rawResource);
    expect(typeof normalized.body).toBe('string');
    rawResource.body = new Uint8Array(1);
    normalizeResource(rawResource);
    expect(Buffer.isBuffer(normalized.body)).toBeTruthy();

  });

  // https://github.com/website-local/website-scrap-engine/issues/107
  test('skipReplacePathError skip if true', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'localhost:3000',
      'https://nodejs.com/api/',
      '/tmp/aaa',
      undefined, undefined, true);
    expect(resource.replaceUri?.toString()).toBe('localhost:3000');
    expect(resource.shouldBeDiscardedFromDownload).toBe(true);
  });

  // https://github.com/website-local/website-scrap-engine/issues/107
  test('skipReplacePathError throw error if false', () => {
    expect(() => createResource(ResourceType.Html, 1,
      'localhost:3000',
      'https://nodejs.com/api/',
      '/tmp/aaa')).toThrowError();
  });
});
