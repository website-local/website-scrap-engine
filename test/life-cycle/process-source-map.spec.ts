import {
  createResource,
  CreateResourceArgument,
  Resource,
  ResourceType
} from '../../src/resource';
import {
  isUriChar,
  processSourceMap,
  SOURCE_MAP_HEADER, sourceMapPrefix, X_SOURCE_MAP_HEADER
} from '../../src/life-cycle/process-source-map';
import {DownloadResource} from '../../src/life-cycle/types';
import {defaultLifeCycle} from '../../src/life-cycle';
import {PipelineExecutorImpl} from '../../src/downloader';
import {StaticDownloadOptions} from '../../src/options';

const fakeRes = (url: string): DownloadResource => {
  const arg: CreateResourceArgument = {
    localRoot: '',
    type: ResourceType.Binary,
    depth: 1,
    url,
    refUrl:'https://example.com/',
    refType: ResourceType.Binary
  };
  const resource = createResource(arg);
  resource.body = '';
  return resource as DownloadResource;
};

const pipeline = new PipelineExecutorImpl(defaultLifeCycle(), {}, {
  concurrency: 0,
  encoding: {},
  localRoot: '',
  maxDepth: 0,
  meta: {}
} as StaticDownloadOptions);

const process = async(res: DownloadResource) => {
  let resources: Resource[] = [];
  const submit = (r: Resource | Resource[]) => {
    if (Array.isArray(r)) {
      resources = resources.concat(r);
    } else {
      resources.push(r);
    }
  };
  await processSourceMap(res, submit, pipeline.options, pipeline);
  return resources;
};

describe('process-source-map', function () {
  test('header', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    res.meta.headers = {
      [SOURCE_MAP_HEADER]: 'noop.js.map'
    };
    const resources: Resource[] = await process(res);
    expect(resources.length).toBe(1);
    expect(resources[0].url).toBe(
      'https://example.com/aaa/noop.js.map');
    expect(resources[0].replacePath).toBe('noop.js.map');
  });

  test('header with unsupported encoding', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    res.meta.headers = {
      [SOURCE_MAP_HEADER]: 'noop.js.map'
    };
    res.encoding = 'ucs2';
    res.body = new Uint8Array(1);
    const resources: Resource[] = await process(res);
    expect(resources.length).toBe(1);
    expect(resources[0].url).toBe(
      'https://example.com/aaa/noop.js.map');
    expect(resources[0].replacePath).toBe('noop.js.map');
  });

  test('header array', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    res.meta.headers = {
      [SOURCE_MAP_HEADER]: ['noop.js.map']
    };
    const resources: Resource[] = await process(res);
    expect(resources.length).toBe(1);
    expect(resources[0].url).toBe(
      'https://example.com/aaa/noop.js.map');
    expect(resources[0].replacePath).toBe('noop.js.map');
  });

  test('header array with invalid body', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    res.meta.headers = {
      [SOURCE_MAP_HEADER]: ['noop.js.map']
    };
    // make an invalid body
    Reflect.set(res, 'body', {});
    const resources: Resource[] = await process(res);
    expect(resources.length).toBe(1);
    expect(resources[0].url).toBe(
      'https://example.com/aaa/noop.js.map');
    expect(resources[0].replacePath).toBe('noop.js.map');
  });

  test('deprecated header', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    res.meta.headers = {
      [X_SOURCE_MAP_HEADER]: 'noop1.js.map'
    };
    const resources: Resource[] = await process(res);
    expect(resources.length).toBe(1);
    expect(resources[0].url).toBe(
      'https://example.com/aaa/noop1.js.map');
    expect(resources[0].replacePath).toBe('noop1.js.map');
  });

  test('string body relative path', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    for (const prefix of sourceMapPrefix) {
      res.body = `
    const aaa = {};
    ${prefix}noop3.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`;
      const resources: Resource[] = await process(res);
      expect(resources.length).toBe(1);
      expect(resources[0].url).toBe(
        'https://example.com/aaa/noop3.js.map');
      expect(resources[0].replacePath).toBe('noop3.js.map');
      expect(res.body).toBe(`
    const aaa = {};
    ${prefix}noop3.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`);
    }
  });

  test('string body absolute path', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    for (const prefix of sourceMapPrefix) {
      res.body = `
    const aaa = {};
    ${prefix}/bbb/noop4.js.map${prefix[1] === '*' ? '*/' : ''}`;
      const resources: Resource[] = await process(res);
      expect(resources.length).toBe(1);
      expect(resources[0].url).toBe(
        'https://example.com/bbb/noop4.js.map');
      expect(resources[0].replacePath).toBe('../bbb/noop4.js.map');
      expect(res.body).toBe(`
    const aaa = {};
    ${prefix}../bbb/noop4.js.map${prefix[1] === '*' ? '*/' : ''}`);
    }
  });

  test('string body absolute path 2', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    for (const prefix of sourceMapPrefix) {
      res.body = `
    const aaa = {};
    ${prefix}/aaa/noop5.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`;
      const resources: Resource[] = await process(res);
      expect(resources.length).toBe(1);
      expect(resources[0].url).toBe(
        'https://example.com/aaa/noop5.js.map');
      expect(resources[0].replacePath).toBe('noop5.js.map');
      expect(res.body).toBe(`
    const aaa = {};
    ${prefix}noop5.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`);
    }
  });

  test('string body remote path', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    for (const prefix of sourceMapPrefix) {
      res.body = `
    const aaa = {};
    ${prefix}https://example1.com/aaa/noop6.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`;
      const resources: Resource[] = await process(res);
      expect(resources.length).toBe(1);
      expect(resources[0].url).toBe(
        'https://example1.com/aaa/noop6.js.map');
      expect(resources[0].replacePath).toBe(
        '../../example1.com/aaa/noop6.js.map');
      expect(res.body).toBe(`
    const aaa = {};
    ${prefix}../../example1.com/aaa/noop6.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`);
    }
  });

  test('buffer body relative path', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    for (const prefix of sourceMapPrefix) {
      res.body = Buffer.from(`
    const aaa = {};
    ${prefix}noop7.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`);
      const resources: Resource[] = await process(res);
      expect(resources.length).toBe(1);
      expect(resources[0].url).toBe(
        'https://example.com/aaa/noop7.js.map');
      expect(resources[0].replacePath).toBe('noop7.js.map');
      expect(res.body.toString()).toBe(`
    const aaa = {};
    ${prefix}noop7.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`);
    }
  });

  test('buffer body absolute path', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    for (const prefix of sourceMapPrefix) {
      res.body = Buffer.from(`
    const aaa = {};
    ${prefix}/bbb/noop8.js.map${prefix[1] === '*' ? '*/' : ''}`);
      const resources: Resource[] = await process(res);
      expect(resources.length).toBe(1);
      expect(resources[0].url).toBe(
        'https://example.com/bbb/noop8.js.map');
      expect(resources[0].replacePath).toBe('../bbb/noop8.js.map');
      expect(res.body.toString()).toBe(`
    const aaa = {};
    ${prefix}../bbb/noop8.js.map${prefix[1] === '*' ? '*/' : ''}`);
    }
  });

  test('buffer body absolute path 2', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    for (const prefix of sourceMapPrefix) {
      res.body = Buffer.from(`
    const aaa = {};
    ${prefix}/aaa/noop9.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`);
      const resources: Resource[] = await process(res);
      expect(resources.length).toBe(1);
      expect(resources[0].url).toBe(
        'https://example.com/aaa/noop9.js.map');
      expect(resources[0].replacePath).toBe('noop9.js.map');
      expect(res.body.toString()).toBe(`
    const aaa = {};
    ${prefix}noop9.js.map${prefix[1] === '*' ? '     */' : '     '}
    const bbb = {}`);
    }
  });

  test('buffer body remote path', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    for (const prefix of sourceMapPrefix) {
      res.body = `
    const aaa = {};
    ${prefix}https://example1.com/aaa/noop10.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`;
      const resources: Resource[] = await process(res);
      expect(resources.length).toBe(1);
      expect(resources[0].url).toBe(
        'https://example1.com/aaa/noop10.js.map');
      expect(resources[0].replacePath).toBe(
        '../../example1.com/aaa/noop10.js.map');
      expect(res.body.toString()).toBe(`
    const aaa = {};
    ${prefix}../../example1.com/aaa/noop10.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`);
    }
  });

  test('array buffer body absolute path', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    for (const prefix of sourceMapPrefix) {
      const buffer = Buffer.from(`
    const aaa = {};
    ${prefix}/aaa/noop11.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`);
      // workaround buffer pooling
      res.body = buffer.buffer.slice(buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength);
      const resources: Resource[] = await process(res);
      expect(resources.length).toBe(1);
      expect(resources[0].url).toBe(
        'https://example.com/aaa/noop11.js.map');
      expect(resources[0].replacePath).toBe('noop11.js.map');
      expect(res.body).toBeInstanceOf(Buffer);
      expect(res.body.toString()).toBe(`
    const aaa = {};
    ${prefix}noop11.js.map${prefix[1] === '*' ? '     */' : '     '}
    const bbb = {}`);
    }
  });

  test('array buffer view body absolute path', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    for (const prefix of sourceMapPrefix) {
      res.body = Uint8Array.from(Buffer.from(`
    const aaa = {};
    ${prefix}/aaa/noop12.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`));
      const resources: Resource[] = await process(res);
      expect(resources.length).toBe(1);
      expect(resources[0].url).toBe(
        'https://example.com/aaa/noop12.js.map');
      expect(resources[0].replacePath).toBe('noop12.js.map');
      expect(res.body).toBeInstanceOf(Buffer);
      expect(res.body.toString()).toBe(`
    const aaa = {};
    ${prefix}noop12.js.map${prefix[1] === '*' ? '     */' : '     '}
    const bbb = {}`);
    }
  });

  test('array buffer view body unsupported encoding', async () => {
    const res = fakeRes('https://example.com/aaa/noop.js');
    res.encoding = 'utf16le';
    for (const prefix of sourceMapPrefix) {
      res.body = Uint8Array.from(Buffer.from(`
    const aaa = {};
    ${prefix}/aaa/noop12.js.map${prefix[1] === '*' ? '*/' : ''}
    const bbb = {}`));
      const resources: Resource[] = await process(res);
      expect(resources.length).toBe(0);
    }
  });

  test('isUriChar', () => {
    const reservedCharacters = '! # $ & \' ( ) + , / : ; = ? @ [ ]'
      .replace(/ /g, '');
    const unreservedCharacters = `
A B C D E F G H I J K L M N O P Q R S T U V W X Y Z
a b c d e f g h i j k l m n o p q r s t u v w x y z
0 1 2 3 4 5 6 7 8 9 - _ . ~`.replace(/[ \n]/g, '');
    for (let i = 0, char: string, expected: boolean; i < 4096; i++) {
      char = String.fromCharCode(i);
      expected = reservedCharacters.includes(char) ||
        unreservedCharacters.includes(char);
      expect(isUriChar(i)).toBe(expected);
    }
  });
});
