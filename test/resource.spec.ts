import {createResource, Resource, ResourceType} from '../src/resource';
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
    expect(resource).toBeTruthy();
    expect(resource.type).toBe(ResourceType.Html);
    expect(resource.depth).toBe(1);
    expect(resource.replacePath).toBe('#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe(path.normalize('nodejs.cn/api/index.html'));
  });
});
