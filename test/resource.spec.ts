import {describe, expect, test} from '@jest/globals';
import {join, normalize} from 'node:path';
import type {
  CreateResourceArgument,
  RawResource,
  Resource
} from '../src/resource.js';
import {
  checkAbsoluteUri,
  createResource,
  generateSavePath,
  normalizeResource,
  prepareResourceForClone,
  resolveFileUrl,
  ResourceType,
  urlOfSavePath
} from '../src/resource.js';
import URI from 'urijs';

describe('resource', function () {
  test('html-to-html-resource', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/buffer.html#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays.html',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource).toBeTruthy();
    expect(resource.type).toBe(ResourceType.Html);
    expect(resource.depth).toBe(1);
    expect(resource.rawUrl).toBe(
      'http://nodejs.cn/api/buffer.html#buffer_buffers_and_typedarrays');
    expect(resource.replacePath).toBe('../buffer.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(join('nodejs.cn', 'api', 'buffer.html'));
  });
  test('path-to-html-resource', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/buffer.html#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../buffer.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/buffer.html'));
  });
  test('html-to-path-resource', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/buffer#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays.html',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../buffer.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/buffer.html'));
  });
  test('html-to-index-resource', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays.html',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/index.html'));
  });
  test('index-to-index-resource', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/buffer/',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/index.html'));
  });
  test('path-to-path-resource', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/buffer#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../buffer.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/buffer.html'));
  });
  test('html-self-link-resource', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/buffer.html#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/buffer.html',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/buffer.html'));
  });
  test('htm-self-link-resource', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/buffer.htm#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/buffer.htm',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/buffer.html'));
  });
  test('path-self-link-resource', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/buffer#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/buffer',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/buffer.html'));
  });
  test('path-index-self-link-resource', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/index.html'));
  });
  test('cross-host-link-resource', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.com/api/#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe(
      '../../nodejs.com/api/index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.com/api/index.html'));
  });
  test('cross-host-link-resource-with-different-protocol', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'https://nodejs.com/api/#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe(
      '../../nodejs.com/api/index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.com/api/index.html'));
  });
  test('cross-host-link-resource-with-no-protocol', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: '//nodejs.com/api/#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'https://nodejs.cn/api/',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe(
      '../../nodejs.com/api/index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.com/api/index.html'));
  });
  test('relative-link', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: '#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'https://nodejs.com/api/',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.com/api/index.html'));
  });
  test('same-site-absolute-link', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: '/#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'https://nodejs.com/api/',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../index.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(normalize('nodejs.com/index.html'));
  });

  test('path-to-html-resource-not-keeping-search', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/buffer.html?page=1#aaa',
      localRoot: '/tmp/aaa',
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../buffer.html#aaa');
    expect(resource.url).toBe('http://nodejs.cn/api/buffer.html#aaa');
    expect(resource.uri?.toString()).toBe(resource.url);
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/buffer.html'));
  });
  test('path-to-html-resource-with-search', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/buffer.html?page=1#aaa',
      localRoot: '/tmp/aaa',
      encoding: 'utf8',
      keepSearch: true,
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../buffer_page=1.html#aaa');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/buffer_page=1.html'));
  });
  test('path-to-html-resource-with-multi-search', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/buffer.html?page=1&a=b&page=2#aaa',
      localRoot: '/tmp/aaa',
      encoding: 'utf8',
      keepSearch: true,
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe(
      '../buffer_a=b_page=1_page=2.html#aaa');
    expect(resource.savePath).toBe(normalize(
      'nodejs.cn/api/buffer_a=b_page=1_page=2.html'));
  });
  test('path-to-index-resource-with-search', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/?page=1#aaa',
      localRoot: '/tmp/aaa',
      encoding: 'utf8',
      keepSearch: true,
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../index_page=1.html#aaa');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/index_page=1.html'));
  });
  test('css-resource-with-search', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Css,
      depth: 1,
      url: 'http://nodejs.cn/api/api.css?page=1#aaa',
      localRoot: '/tmp/aaa',
      encoding: 'utf8',
      keepSearch: true,
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../api_page=1.css#aaa');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/api_page=1.css'));
  });
  test('no-ext-resource-with-search', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Binary,
      depth: 1,
      url: 'http://nodejs.cn/api/api?page=1#aaa',
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      refType: ResourceType.Binary,
      localRoot: '/tmp/aaa',
      encoding: 'utf8',
      keepSearch: true,
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../api_page=1#aaa');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/api_page=1'));
  });
  test('path-to-index-resource-with-long-search', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/?page=1' + 'a'.repeat(1000) + '#aaa',
      refUrl: 'http://nodejs.cn/api/buffer/buffers_and_typedarrays',
      refType: ResourceType.Html,
      localRoot: '/tmp/aaa',
      encoding: 'utf8',
      keepSearch: true,
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe(
      '../index_g6rVCvz2dtFaE2fbrIJTGyzhYtGRYC-6EJAwoGeLm-Q.html#aaa');
    expect(resource.savePath).toBe(normalize(
      'nodejs.cn/api/index_g6rVCvz2dtFaE2fbrIJTGyzhYtGRYC-6EJAwoGeLm-Q.html'));
  });
  test('index-to-index-resource-with-search', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'http://nodejs.cn/api/?page=1#aaa',
      refUrl: 'http://nodejs.cn/api/buffer/',
      refType: ResourceType.Html,
      localRoot: '/tmp/aaa',
      encoding: 'utf8',
      keepSearch: true,
    };
    const resource: Resource = createResource(arg);
    expect(resource.replacePath).toBe('../index_page=1.html#aaa');
    expect(resource.savePath).toBe(normalize('nodejs.cn/api/index_page=1.html'));
  });
  test('prepare-resource-for-clone', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: '/#buffer_buffers_and_typedarrays',
      localRoot: '/tmp/aaa',
      refUrl: 'https://nodejs.com/api/',
      refType: ResourceType.Html
    };
    const resource: Resource = createResource(arg);
    const expected: Resource = {
      type: 2,
      depth: 1,
      encoding: 'utf8',
      url: 'https://nodejs.com/#buffer_buffers_and_typedarrays',
      rawUrl: '/#buffer_buffers_and_typedarrays',
      downloadLink: 'https://nodejs.com/',
      refUrl: 'https://nodejs.com/api/',
      refSavePath: join('nodejs.com', 'api', 'index.html'),
      savePath: join('nodejs.com', 'index.html'),
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
      refSavePath: 'nodejs.com\\api\\index.html',
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
    rawResource.body = new Uint32Array(1);
    normalizeResource(rawResource);
    expect(Buffer.isBuffer(normalized.body)).toBeTruthy();

  });

  // https://github.com/website-local/website-scrap-engine/issues/107
  test('skipReplacePathError skip if true', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'localhost:3000',
      refUrl: 'https://nodejs.com/api/',
      refType: ResourceType.Html,
      localRoot: '/tmp/aaa',
      skipReplacePathError: true,
    };
    const resource: Resource = createResource(arg);
    expect(resource.replaceUri?.toString()).toBe('localhost:3000');
    expect(resource.shouldBeDiscardedFromDownload).toBe(true);
  });

  // https://github.com/website-local/website-scrap-engine/issues/107
  test('skipReplacePathError throw error if false', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: 'localhost:3000',
      refUrl: 'https://nodejs.com/api/',
      refType: ResourceType.Html,
      localRoot: '/tmp/aaa'
    };
    expect(() => createResource(arg)).toThrowError();
  });

  // BREAKING CHANGE v0.4
  // https://github.com/medialize/URI.js/commit/ac43ca8f80c042f0256fb551ea5203863dec4481
  // https://github.com/website-local/website-scrap-engine/pull/301
  test('merge leading slashes for the web protocols', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      // since URI.js v1.19.7, http:///aaa -> http://aaa
      url: 'http:///aaa',
      refUrl: 'https://nodejs.com/api/',
      refType: ResourceType.Html,
      localRoot: '/tmp/aaa',
    };
    const resource: Resource = createResource(arg);
    expect(resource.replaceUri?.toString()).toBe('../../aaa/index.html');
    expect(resource.shouldBeDiscardedFromDownload).toBeFalsy();
  });

  test('urlOfSavePath', () => {
    expect(urlOfSavePath('aaa')).toBe('file:///aaa');
    expect(urlOfSavePath('aaa/bbb')).toBe('file:///aaa/bbb');
    expect(urlOfSavePath('aaa\\bbb')).toBe('file:///aaa/bbb');
  });

  test('generateSavePath no relative uri', () => {
    expect(() => generateSavePath(URI('aaaa'))).toThrowError();
  });

  // https://github.com/website-local/website-scrap-engine/issues/126
  test('generateSavePath no localSrcRoot', () => {
    expect(() => generateSavePath(URI('file://aaaaa'))).toThrowError();
  });

  test('generateSavePath windows file uri', () => {
    // save original process.platform
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });
    try {
      const urlArr = [
        'file:///D:/tmp/aaa/bbb/a.html',
        'file:///D:/tmp/aaa/bbb/',
        'file:///D:/tmp/aaa/',
        'file:///D:/tmp/aaa/index.html',
        'file:///D:/tmp/aaa/123457.html',
        'file:///D:/tmp/aaa/123/345/678.html',
      ];
      const expected = [
        'bbb/a.html',
        'bbb/index.html',
        'index.html',
        'index.html',
        '123457.html',
        '123/345/678.html',
      ];
      for (let i = 0; i < urlArr.length; i++) {
        expect(generateSavePath(URI(urlArr[i]),
          true, false, 'D:/tmp/aaa'))
          .toBe(expected[i]);
        expect(generateSavePath(URI(urlArr[i]),
          true, false, 'D:/tmp/aaa/'))
          .toBe(expected[i]);
      }
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform!);
    }
  });

  test('resolveFileUrl no localSrcRoot', () => {
    expect(() => resolveFileUrl('', ''))
      .toThrowError('can not use file url without localSrcRoot');
  });

  test('resolveFileUrl skip error on skipReplacePathError', () => {
    expect(resolveFileUrl(
      '111', '', undefined, true))
      .toBe('');
  });

  test('resolveFileUrl url not starting with localSrcRoot', () => {
    expect(() =>
      resolveFileUrl('file:///dev/vda1', '', '/tmp/'))
      .toThrowError('file url not starting with localSrcRoot is forbidden');
  });

  test('resolveFileUrl refUrl not starting with localSrcRoot', () => {
    expect(() => resolveFileUrl(
      'file:///tmp/11', 'file:///dev/11', '/tmp/'))
      .toThrowError('file refUrl not starting with localSrcRoot is forbidden');
  });

  test('resolveFileUrl absolute url', () => {
    expect(resolveFileUrl(
      'file:///tmp/11', 'file:///tmp/22', '/tmp/'))
      .toBe('file:///tmp/11');
  });

  test('resolveFileUrl http url', () => {
    expect(resolveFileUrl('http://example.com/tmp/11', ''))
      .toBe('http://example.com/tmp/11');
    expect(resolveFileUrl('https://example.com/tmp/11', ''))
      .toBe('https://example.com/tmp/11');
  });

  test('resolveFileUrl windows absolute url', () => {
    expect(resolveFileUrl(
      'file:///C:/tmp/11', 'file:///C:/tmp/22', 'C:/tmp/'))
      .toBe('file:///C:/tmp/11');
  });

  test('resolveFileUrl relative url', () => {
    expect(resolveFileUrl(
      '11', 'file:///tmp/22', '/tmp/'))
      .toBe('file:///tmp/11');
    expect(resolveFileUrl(
      '../../11', 'file:///tmp/22', '/tmp/'))
      .toBe('file:///tmp/11');
    expect(resolveFileUrl(
      '/11', 'file:///tmp/22', '/tmp/'))
      .toBe('file:///tmp/11');
    expect(resolveFileUrl(
      '//11', 'file:///tmp/22', '/tmp/'))
      .toBe('file:///tmp/11');
    expect(resolveFileUrl(
      '/11', 'file:///tmp/1/1/1/1/22', '/tmp/'))
      .toBe('file:///tmp/11');
    expect(resolveFileUrl(
      '../../11', 'file:///tmp/1/1/1/1/22', '/tmp/'))
      .toBe('file:///tmp/1/1/11');
    expect(resolveFileUrl(
      '../../../../../11', 'file:///tmp/1/22', '/tmp/'))
      .toBe('file:///tmp/11');
  });


  test('resolveFileUrl windows relative url', () => {
    expect(resolveFileUrl(
      '11', 'file:///D:/tmp/22', 'D:/tmp/'))
      .toBe('file:///D:/tmp/11');
    expect(resolveFileUrl(
      '../../11', 'file:///D:/tmp/22', 'D:/tmp/'))
      .toBe('file:///D:/tmp/11');
    expect(resolveFileUrl(
      '/11', 'file:///D:/tmp/22', 'D:/tmp/'))
      .toBe('file:///D:/tmp/11');
    expect(resolveFileUrl(
      '//11', 'file:///D:/tmp/22', 'D:/tmp/'))
      .toBe('file:///D:/tmp/11');
    expect(resolveFileUrl(
      '/11', 'file:///D:/tmp/1/1/1/1/22', 'D:/tmp/'))
      .toBe('file:///D:/tmp/11');
    expect(resolveFileUrl(
      '../../11', 'file:///D:/tmp/1/1/1/1/22', 'D:/tmp/'))
      .toBe('file:///D:/tmp/1/1/11');
    expect(resolveFileUrl(
      '../../../../../11', 'file:///D:/tmp/1/22', 'D:/tmp/'))
      .toBe('file:///D:/tmp/11');
  });

  test('createResource file url', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: '/',
      refUrl: 'file:///tmp/example.com/api/',
      refType: ResourceType.Html,
      localRoot: '/tmp/aaa',
      localSrcRoot: '/tmp/example.com/'
    };
    const resource: Resource = createResource(arg);
    expect(resource.replaceUri?.toString()).toBe('../index.html');
    expect(resource.savePath).toBe('index.html');
    expect(resource.downloadLink).toBe('file:///tmp/example.com/');
  });

  test('createResource file url skip error', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      url: '/',
      refUrl: 'file:///tmp/bbb/api/',
      refType: ResourceType.Html,
      localRoot: '/tmp/aaa',
      localSrcRoot: '/tmp/example.com/',
      skipReplacePathError: true
    };
    const resource: Resource = createResource(arg);
    expect(resource.replaceUri?.toString()).toBe('/');
    expect(resource.downloadLink).toBe('/');
    expect(resource.shouldBeDiscardedFromDownload).toBe(true);
  });

  test('createResource file relative url', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Binary,
      depth: 1,
      url: '../../../../../../../../static/main.js',
      refUrl: 'file:///tmp/example.com/api/',
      refType: ResourceType.Html,
      localRoot: '/tmp/aaa',
      localSrcRoot: '/tmp/example.com/'
    };
    const resource: Resource = createResource(arg);
    expect(resource.replaceUri?.toString()).toBe('../static/main.js');
    expect(resource.savePath).toBe('static/main.js');
    expect(resource.downloadLink).toBe(
      'file:///tmp/example.com/static/main.js');
  });

  test('createResource file url windows', () => {

    // save original process.platform
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });
    try {
      const arg: CreateResourceArgument = {
        type: ResourceType.Html,
        depth: 1,
        url: '/',
        refUrl: 'file:///D:/tmp/example.com/api/',
        refType: ResourceType.Html,
        localRoot: '/tmp/aaa',
        localSrcRoot: 'D:/tmp/example.com/'
      };
      const resource: Resource = createResource(arg);
      expect(resource.replaceUri?.toString()).toBe('../index.html');
      expect(resource.savePath).toBe('index.html');
      expect(resource.downloadLink).toBe('file:///D:/tmp/example.com/');
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform!);
    }
  });

  test('checkAbsoluteUri throws on empty host', () => {
    const checkAbsoluteUri0 = (
      url: string,
      refUrl: string,
      skipReplacePathError?: boolean
    ) => checkAbsoluteUri(
      URI(url), URI(refUrl),
      skipReplacePathError,
      url, refUrl, ResourceType.Binary);

    expect(checkAbsoluteUri0('ftp://111', 'http://111', true))
      .toBe(true);
    expect(() => checkAbsoluteUri0('ftp://111', 'http://111'))
      .toThrow('protocol ftp not supported');
    expect(checkAbsoluteUri0('ftp://111', 'ftp://111'))
      .toBe(false);


    expect(checkAbsoluteUri0('http://aa', 'http://bbb')).toBe(false);

    expect(checkAbsoluteUri0('aa', 'http://bbb', true))
      .toBe(true);
    expect(() => checkAbsoluteUri0('aa', 'http://bbb'))
      .toThrow('protocol  not supported');

    expect(checkAbsoluteUri0('http:///', 'http:///aaa', true))
      .toBe(true);
    expect(() => checkAbsoluteUri0('http:///', 'http:///aaa'))
      .toThrow('empty host for non-file uri not supported');

    expect(checkAbsoluteUri0('file:///', 'file:///aaa', true))
      .toBe(false);
  });

  // BREAKING CHANGE v0.6
  // resource: custom callback for rewriting savePath
  // https://github.com/website-local/website-scrap-engine/issues/383
  test('custom callback for rewriting savePath', () => {
    const arg: CreateResourceArgument = {
      type: ResourceType.Html,
      depth: 1,
      // since URI.js v1.19.7, http:///aaa -> http://aaa
      url: 'http:///aaa',
      refUrl: 'https://nodejs.com/api/',
      refSavePath: join('nodejs.com', 'api', 'index.html'),
      refType: ResourceType.Html,
      localRoot: '/tmp/aaa',
      generateSavePathFn: () => join('nodejs.com', 'aaa.html'),
    };
    const resource: Resource = createResource(arg);
    expect(resource.replaceUri?.toString()).toBe('../aaa.html');
    expect(resource.savePath?.toString()).toBe(join('nodejs.com', 'aaa.html'));
    expect(resource.shouldBeDiscardedFromDownload).toBeFalsy();
  });
});
