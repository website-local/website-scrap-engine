import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultDownloadOptions} from '../../src/options.js';
import type {ResourceEncoding} from '../../src/resource.js';
import {createResource, ResourceType} from '../../src/resource.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {localUrlMounts} from '../../src/life-cycle/local-url-mount.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'wse-encoding-'));
});

afterEach(async () => {
  await fs.rm(root, {recursive: true, force: true});
});

describe.each(['file', 'mount'])('%s resource encoding', source => {
  test.each([undefined, null] as Array<ResourceEncoding | undefined>)(
    'preserves binary bytes with encoding %s', async encoding => {
      const sourceRoot = path.join(root, 'source');
      await fs.mkdir(sourceRoot);
      const bytes = Buffer.from([0xff, 0x00, 0x80, 0xc3, 0x28, 0x42]);
      const sourcePath = path.join(sourceRoot, 'image.bin');
      await fs.writeFile(sourcePath, bytes);
      const lc = defaultLifeCycle();
      if (source === 'mount') {
        lc.download.unshift(localUrlMounts([
          {root: sourceRoot, urlPrefix: 'https://example.com/'}
        ]));
      }
      const encodings = {} as Record<ResourceType, ResourceEncoding>;
      if (encoding !== undefined) encodings[ResourceType.Binary] = encoding;
      const options = defaultDownloadOptions({
        ...lc,
        localRoot: path.join(root, 'output'),
        localSrcRoot: pathToFileURL(sourceRoot).href.slice('file:///'.length),
        encoding: encodings,
        req: {},
        meta: {}
      });
      const pipeline = new PipelineExecutorImpl(options, options.req, options);
      const url = source === 'file' ? pathToFileURL(sourcePath).href :
        'https://example.com/image.bin';
      const resource = await pipeline.createResource(ResourceType.Binary, 1, url, url);
      if (!resource) throw new Error('Resource was discarded');
      const downloaded = await pipeline.download(resource);
      expect(downloaded).toBeDefined();
      if (!downloaded) throw new Error('Resource was not downloaded');
      await pipeline.saveToDisk(downloaded);

      expect(resource.encoding).toBeNull();
      expect(Buffer.isBuffer(downloaded.body)).toBe(true);
      expect(await fs.readFile(path.join(options.localRoot, resource.savePath)))
        .toEqual(bytes);
    }
  );
});

describe('resource encoding precedence', () => {
  test.each([
    {type: ResourceType.Binary, encoding: undefined, expected: null},
    {type: ResourceType.StreamingBinary, encoding: undefined, expected: null},
    {type: ResourceType.Html, encoding: undefined, expected: 'utf8'},
    {type: ResourceType.Html, encoding: null, expected: null},
    {type: ResourceType.Binary, encoding: 'latin1', expected: 'latin1'}
  ] as Array<{
    type: ResourceType;
    encoding: ResourceEncoding | undefined;
    expected: ResourceEncoding;
  }>)('uses $expected for type $type with encoding $encoding',
    ({type, encoding, expected}) => {
      const resource = createResource({
        type, encoding, depth: 0, localRoot: root,
        url: 'https://example.com/file', refUrl: 'https://example.com/'
      });
      expect(resource.encoding).toBe(expected);
    });

  test('an explicit encoding overrides the configured encoding', async () => {
    const options = defaultDownloadOptions({
      ...defaultLifeCycle(),
      localRoot: root,
      encoding: {[ResourceType.Binary]: 'utf8'} as Record<ResourceType, ResourceEncoding>,
      req: {},
      meta: {}
    });
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const resource = await pipeline.createResource(ResourceType.Binary, 0,
      'https://example.com/file', 'https://example.com/', undefined, null);
    expect(resource?.encoding).toBeNull();
  });
});
