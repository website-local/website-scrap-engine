import {createResource, Resource, ResourceType} from '../src/resource';

describe('resource', function () {
  it('html-to-html-resource', () => {
    const resource: Resource = createResource(ResourceType.Html, 1,
      'http://nodejs.cn/api/buffer.html#buffer_buffers_and_typedarrays',
      'http://nodejs.cn/api/buffer/buffers_and_typedarrays.html',
      '/tmp/aaa');
    expect(resource).toBeTruthy();
    expect(resource.type).toBe(ResourceType.Html);
    expect(resource.depth).toBe(1);
    expect(resource.replacePath).toBe('../buffer.html#buffer_buffers_and_typedarrays');
    expect(resource.savePath).toBe('nodejs.cn\\api\\buffer.html');
  });
});
