import {afterEach, beforeEach, expect, test} from '@jest/globals';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {markAsUntransferable} from 'node:worker_threads';
import {saveResourceToDisk} from '../../src/life-cycle/save-resource-to-disk.js';
import {saveHtmlToDisk} from '../../src/life-cycle/save-html-to-disk.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource, ResourceBody} from '../../src/resource.js';
import type {DownloadResource} from '../../src/life-cycle/types.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {load} from '../../src/cheerio.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'save-body-')); });
afterEach(async () => { await rm(dir, {recursive: true, force: true}); });

function setup(body: ResourceBody, type = ResourceType.Binary) {
  const url = 'https://example.org/asset';
  const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: dir, initialUrl: []});
  const resource = createResource({type, depth: 0, localRoot: dir, url, refUrl: url, savePath: 'asset'});
  resource.body = body;
  const pipeline = new PipelineExecutorImpl(options, options.req, options);
  return {resource: resource as DownloadResource, options, pipeline};
}

test.each([ResourceType.Binary, ResourceType.Css, ResourceType.Svg, ResourceType.SiteMap])(
  'saving type %s writes bytes and releases the complete store', async type => {
    const bytes = new Uint8Array([1, 2, 3]);
    const {resource, options, pipeline} = setup(Buffer.from(bytes.buffer), type);
    await saveResourceToDisk(resource, options, pipeline);
    expect(await readFile(join(dir, 'asset'))).toEqual(Buffer.from([1, 2, 3]));
    expect(bytes.byteLength).toBe(0);
    expect(resource.body).toBeUndefined();
  });

test.each(['arraybuffer', 'dataview', 'foreign'])(
  'releases a complete %s body', async kind => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const body: ResourceBody = kind === 'arraybuffer' ? buffer : kind === 'dataview' ?
      new DataView(buffer) : runInNewContext('new Uint8Array([1, 2, 3])') as Uint8Array;
    const {resource, options, pipeline} = setup(body);
    await saveResourceToDisk(resource, options, pipeline);
    expect(await readFile(join(dir, 'asset'))).toEqual(Buffer.from([1, 2, 3]));
    expect(ArrayBuffer.isView(body) ? body.buffer.byteLength : body.byteLength).toBe(0);
    expect(resource.body).toBeUndefined();
  });

test.each(['partial', 'shared', 'protected', 'pooled', 'wasm'])(
  'drops the resource reference without detaching a %s store', async kind => {
    const whole = new Uint8Array([1, 2, 3, 4]);
    let body: ResourceBody;
    if (kind === 'partial') body = new DataView(whole.buffer, 1, 2);
    else if (kind === 'shared') body = new Uint8Array(new SharedArrayBuffer(8)).fill(3);
    else if (kind === 'protected') {
      body = Buffer.allocUnsafeSlow(8).fill(3);
      markAsUntransferable(body.buffer);
    } else if (kind === 'pooled') body = Buffer.from([1, 2, 3]);
    else body = new Uint8Array(new WebAssembly.Memory({initial: 1}).buffer).fill(3);
    const original = Buffer.from(ArrayBuffer.isView(body) ?
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : new Uint8Array(body));
    const {resource, options, pipeline} = setup(body);
    await saveResourceToDisk(resource, options, pipeline);
    expect(await readFile(join(dir, 'asset'))).toEqual(original);
    expect(body.byteLength).toBe(original.length);
    expect(resource.body).toBeUndefined();
  });

test.each([false, true])('releases after every redirect write (explicit path %s)', async explicit => {
  const bytes = new Uint8Array([4, 5, 6]);
  const {resource, options, pipeline} = setup(bytes);
  resource.redirectedUrl = 'https://example.org/target';
  if (explicit) resource.redirectedSavePath = 'target';
  await saveResourceToDisk(resource, options, pipeline);
  expect(await readFile(join(dir, 'asset'))).toEqual(Buffer.from([4, 5, 6]));
  expect(await readFile(join(dir, explicit ? 'target' : 'example.org/target')))
    .toEqual(Buffer.from([4, 5, 6]));
  expect(bytes.byteLength).toBe(0);
});

test.each(['independent', 'shared-helper-doc', 'shared-owner-doc', 'shared-helper-meta', 'shared-owner-meta'])(
  'binary redirects dispose %s documents after pending observers', async kind => {
    const bytes = new Uint8Array([4, 5, 6]);
    const {resource, options, pipeline} = setup(bytes);
    resource.redirectedUrl = 'https://example.org/target';
    const disposed: number[] = [];
    const observed: number[] = [];
    const document = (id: number) => Object.assign(load('<p>managed</p>'), {
      dispose() { disposed.push(id); }
    });
    resource.meta.doc = document(0);
    const helpers: Resource[] = [];
    options.createResource = arg => {
      const helper = createResource(arg);
      helpers.push(helper);
      const id = helpers.length;
      if (kind === 'shared-owner-meta') helper.meta = resource.meta;
      else if (kind === 'shared-helper-meta' && id === 2) helper.meta = helpers[0].meta;
      else helper.meta.doc = kind === 'shared-owner-doc' ? resource.meta.doc :
        kind === 'shared-helper-doc' && id === 2 ? helpers[0].meta.doc : document(id);
      (helper.meta.statusChanges ??= []).push(new Promise<void>(resolve => setTimeout(() => {
        expect(helper.meta.doc).toBeDefined();
        expect(bytes[0]).toBe(4);
        observed.push(id);
        resolve();
      }, 10)));
      return helper;
    };
    await saveResourceToDisk(resource, options, pipeline);
    expect(observed).toEqual([1, 2]);
    expect(disposed.sort()).toEqual(kind.startsWith('shared-owner') ? [0] :
      kind.startsWith('shared-helper') ? [0, 1] : [0, 1, 2]);
    for (const res of [resource, ...helpers]) expect(res.meta.doc).toBeUndefined();
    expect(await readFile(join(dir, 'asset'))).toEqual(Buffer.from([4, 5, 6]));
    expect(await readFile(join(dir, 'example.org/target'))).toEqual(Buffer.from([4, 5, 6]));
    expect(bytes.byteLength).toBe(0);
  });

test.each(['write', 'dispose'])('binary redirect %s failure still releases every document and retains the body', async failure => {
  const bytes = new Uint8Array([5]);
  const {resource, options, pipeline} = setup(bytes);
  resource.redirectedUrl = 'https://example.org/target';
  const disposed: number[] = [];
  resource.meta.doc = Object.assign(load('owner'), {dispose() { disposed.push(0); }});
  let created = 0;
  options.createResource = arg => {
    const helper = createResource(arg);
    const id = ++created;
    helper.meta.doc = Object.assign(load('helper'), {dispose() {
      disposed.push(id);
      if (failure === 'dispose' && id === 2) throw new Error('helper disposal failed');
    }});
    if (failure === 'write' && id === 2) helper.savePath = '../outside';
    return helper;
  };
  await expect(saveResourceToDisk(resource, options, pipeline))
    .rejects.toThrow(failure === 'write' ? 'escapes root' : 'helper disposal failed');
  expect(disposed).toEqual([2, 1, 0]);
  expect(resource.body).toBe(bytes);
  expect(bytes[0]).toBe(5);
});

test('retains bytes if a later redirect write fails', async () => {
  const bytes = new Uint8Array([5]);
  const {resource, options, pipeline} = setup(bytes);
  resource.redirectedUrl = 'https://example.org/target';
  resource.redirectedSavePath = 'target';
  resource.savePath = '../outside';
  await expect(saveResourceToDisk(resource, options, pipeline)).rejects.toThrow('escapes root');
  expect(await readFile(join(dir, 'target'))).toEqual(Buffer.from([5]));
  expect(resource.body).toBe(bytes);
  expect(bytes[0]).toBe(5);
});

test('pending observers and document disposal can read the body before release', async () => {
  const bytes = new Uint8Array([7]);
  const {resource, options, pipeline} = setup(bytes);
  const observed: number[] = [];
  resource.meta.statusChanges = [new Promise<void>(resolve => setTimeout(() => {
    observed.push(bytes[0]);
    resolve();
  }, 20))];
  resource.meta.doc = Object.assign(load('<p>body</p>'), {dispose() { observed.push(bytes[0]); }});
  await saveResourceToDisk(resource, options, pipeline);
  expect(observed).toEqual([7, 7]);
  expect(resource.meta.doc).toBeUndefined();
  expect(resource.body).toBeUndefined();
  expect(bytes.byteLength).toBe(0);
});

test('failed document disposal leaves the body available', async () => {
  const bytes = new Uint8Array([7]);
  const {resource, options, pipeline} = setup(bytes);
  resource.meta.doc = Object.assign(load('<p>body</p>'), {dispose() { throw new Error('dispose failed'); }});
  await expect(saveResourceToDisk(resource, options, pipeline)).rejects.toThrow('dispose failed');
  expect(resource.body).toBe(bytes);
  expect(bytes[0]).toBe(7);
});

test.each([false, true])('HTML saving releases the original body (redirect %s)', async redirect => {
  const bytes = new Uint8Array(Buffer.from('<p>original</p>'));
  const {resource, options, pipeline} = setup(bytes, ResourceType.Html);
  resource.meta.doc = load('<p>processed</p>');
  if (redirect) {
    resource.redirectedUrl = 'https://example.org/target.html';
    resource.redirectedSavePath = 'target.html';
  }
  await saveHtmlToDisk(resource, options, pipeline);
  expect(await readFile(join(dir, redirect ? 'target.html' : 'asset'), 'utf8'))
    .toContain('<p>processed</p>');
  if (redirect) expect(await readFile(join(dir, 'asset'), 'utf8')).toContain('location.replace');
  expect(resource.body).toBeUndefined();
  expect(resource.meta.doc).toBeUndefined();
  expect(bytes.byteLength).toBe(0);
});

test('HTML failure preserves its downloaded body', async () => {
  const {resource, options, pipeline} = setup('<p>original</p>', ResourceType.Html);
  resource.savePath = '../outside';
  await expect(saveHtmlToDisk(resource, options, pipeline)).rejects.toThrow('escapes root');
  expect(resource.body).toBe('<p>original</p>');
});

test('successful text saving also drops the original body reference', async () => {
  const {resource, options, pipeline} = setup('<p>original</p>', ResourceType.Html);
  await saveHtmlToDisk(resource, options, pipeline);
  expect(resource.body).toBeUndefined();
  expect(await readFile(join(dir, 'asset'), 'utf8')).toBe('<p>original</p>');
});
