import {afterAll, beforeAll, describe, expect, test} from '@jest/globals';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {createResource, ResourceType} from '../../src/resource.js';
import {getLogger, setLogger} from '../../src/logger/logger.js';

let server: Server;
let origin: string;
const received: string[] = [];
const previousLogger = getLogger();

beforeAll(async () => {
  setLogger({trace() {}, debug() {}, info() {}, warn() {}, error() {}, isTraceEnabled: () => false});
  server = createServer((request, response) => {
    received.push(request.url!);
    response.end(request.url);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  setLogger(previousLogger);
});

describe.each(['got', 'got hooks', 'native'] as const)('%s request URLs', mode => {
  test.each([
    '/plain.bin?x=1',
    '/a%2Fb.bin?token=%2F%3D',
    '/a%2fb.bin?token=%2f%3d',
    '/a%23b.bin?token=%23',
    '/a%3Fb.bin?token=%26%3D%3F',
    '/a%3Ab.bin?token=%3B%40%24%2B%2C',
    '/a%41.bin?signature=%41%2F%3D',
    '/literal%25.bin?token=%252F',
    '/a%20b/汉字.bin?q=空 格',
    '/bad%2path.bin?token=%zz'
  ])('preserves the URL bytes for %s', async suffix => {
    const target = origin + suffix;
    const expectedUrl = new URL(target);
    const expectedPath = expectedUrl.pathname + expectedUrl.search;
    const hooks: string[] = [];
    const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: tmpdir(),
      httpTransport: mode === 'native' ? 'native' : 'got',
      req: {retry: {limit: 0}, timeout: {request: 2000},
        ...(mode === 'got hooks' ? {hooks: {beforeRequest: [request => {
          hooks.push(request.url!.pathname + request.url!.search);
        }]}} : {})}});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const resource = createResource({type: ResourceType.Binary, depth: 0, url: target, refUrl: target,
      localRoot: tmpdir(), savePath: 'request.bin', refSavePath: 'request.bin'});
    const before = received.length;

    const downloaded = await pipeline.download(resource);

    if (!downloaded || downloaded === true) throw new Error('Expected a buffered response');
    expect(received.slice(before)).toEqual([expectedPath]);
    expect(downloaded.body.toString()).toBe(expectedPath);
    expect(resource.downloadLink).toBe(expectedUrl.href);
    expect(resource.redirectedUrl).toBe(expectedUrl.href);
    if (mode === 'got hooks') expect(hooks).toEqual([expectedPath]);
    if (mode === 'native') expect(resource.meta.httpTransport).toBe('native');
  });

  test('lets the transport encode a caller-supplied Unicode downloadLink', async () => {
    const target = origin + '/caller supplied/汉字.bin?q=空 格';
    const expected = new URL(target);
    const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: tmpdir(),
      httpTransport: mode === 'native' ? 'native' : 'got',
      req: {retry: {limit: 0}, timeout: {request: 2000}}});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const resource = await pipeline.createResource(ResourceType.Binary, 0, target, target);
    resource.downloadLink = target;

    const downloaded = await pipeline.download(resource);

    if (!downloaded || downloaded === true) throw new Error('Expected a buffered response');
    expect(downloaded.body.toString()).toBe(expected.pathname + expected.search);
  });
});
