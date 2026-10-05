import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {join, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {defaultDownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {localUrlMounts} from '../../src/life-cycle/local-url-mount.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {createResource, ResourceType} from '../../src/resource.js';

let root: string;
let server: Server | undefined;
beforeEach(async () => { root = await fs.mkdtemp(join(process.cwd(), '.wse-size-test-')); });
afterEach(async () => {
  if (server) {
    const closing = new Promise<void>(resolve => server!.close(() => resolve()));
    server.closeAllConnections();
    await closing;
    server = undefined;
  }
  await fs.rm(root, {recursive: true, force: true});
});

describe.each([ResourceType.Binary, ResourceType.StreamingBinary])('resource byte limit (type %s)', type => {
  test.each([false, true])('bounds HTTP bodies after decompression (gzip: %s)', async compressed => {
    let requests = 0;
    const bytes = Buffer.alloc(1000, 97);
    server = createServer((_request, response) => {
      requests++;
      response.setHeader('Connection', 'close');
      if (compressed) response.setHeader('Content-Encoding', 'gzip');
      response.end(compressed ? gzipSync(bytes) : bytes);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/asset`;
    const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root,
      maxResourceBytes: 64, req: {retry: {limit: 0}, timeout: {request: 2000}}});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const resource = createResource({type, depth: 0, url, refUrl: url, localRoot: root, encoding: null});
    const destination = join(root, resource.savePath);
    await fs.mkdir(dirname(destination), {recursive: true});
    await fs.writeFile(destination, 'cached');
    await expect(pipeline.download(resource)).rejects.toMatchObject({code: 'ERR_RESOURCE_SIZE_LIMIT'});
    expect(await fs.readFile(destination, 'utf8')).toBe('cached');
    expect(await fs.readdir(dirname(destination))).toEqual(['asset']);
    expect(requests).toBe(1);
  });

  test('accepts an exact-limit compressed body', async () => {
    server = createServer((_request, response) => {
      response.setHeader('Connection', 'close');
      response.setHeader('Content-Encoding', 'gzip');
      response.end(gzipSync(Buffer.from('abcd')));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/asset`;
    const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root, maxResourceBytes: 4});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const resource = createResource({type, depth: 0, url, refUrl: url, localRoot: root, encoding: null});
    const downloaded = await pipeline.download(resource);
    if (downloaded) await pipeline.saveToDisk(downloaded);
    expect(await fs.readFile(join(root, resource.savePath), 'utf8')).toBe('abcd');
  });

  test.each(['file', 'mount'])('bounds local %s sources', async kind => {
    const sourceRoot = join(root, 'source');
    const output = join(root, 'output');
    await fs.mkdir(sourceRoot);
    const source = join(sourceRoot, 'asset');
    await fs.writeFile(source, '12345678');
    const url = kind === 'file' ? pathToFileURL(source).href : 'https://example.test/asset';
    const lifeCycle = defaultLifeCycle();
    if (kind === 'mount') lifeCycle.download.unshift(localUrlMounts([
      {root: sourceRoot, urlPrefix: 'https://example.test/'}
    ]));
    const options = defaultDownloadOptions({...lifeCycle, localRoot: output, maxResourceBytes: 4});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const resource = createResource({type, depth: 0, url, refUrl: url,
      localRoot: output, localSrcRoot: pathToFileURL(sourceRoot).href.slice('file:///'.length), encoding: null});
    await expect(pipeline.download(resource)).rejects.toMatchObject({code: 'ERR_RESOURCE_SIZE_LIMIT'});
    await expect(fs.stat(join(output, resource.savePath))).rejects.toMatchObject({code: 'ENOENT'});
  });
});

test('counts encoded bytes in hook-provided strings', async () => {
  const lifeCycle = defaultLifeCycle();
  lifeCycle.processBeforeDownload = [res => ({...res, body: '😀'})];
  const options = defaultDownloadOptions({...lifeCycle, localRoot: root, maxResourceBytes: 3});
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  const res = createResource({type: ResourceType.Binary, depth: 0,
    url: 'https://example.test/a', refUrl: 'https://example.test/', localRoot: root, encoding: 'utf8'});
  await expect(pipeline.processBeforeDownload(res, null, null))
    .rejects.toMatchObject({code: 'ERR_RESOURCE_SIZE_LIMIT', actual: 4});
});
