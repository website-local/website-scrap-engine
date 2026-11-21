import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {promises as fs, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  readOrCopyLocalResource,
  readOrCopyLocalResourceWithSavePolicy
} from '../../src/life-cycle/read-or-copy-local-resource.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import type {ExistingResourceFunc} from '../../src/life-cycle/types.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {StaticDownloadOptions} from '../../src/options.js';
import {defaultDownloadOptions} from '../../src/options.js';

let tmpRoot: string;
let localRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'wse-local-file-'));
  localRoot = path.join(tmpRoot, 'dest');
  await fs.mkdir(localRoot, {recursive: true});
});

afterEach(async () => {
  await fs.rm(tmpRoot, {recursive: true, force: true});
});

function options(): StaticDownloadOptions {
  return {
    concurrency: 1,
    encoding: {},
    localRoot,
    maxDepth: 1,
    meta: {}
  } as StaticDownloadOptions;
}

describe('readOrCopyLocalResource', () => {
  test('decodes file URLs before reading local files', async () => {
    const srcPath = path.join(tmpRoot, 'a b.txt');
    await fs.writeFile(srcPath, 'body');
    const resource = createResource({
      type: ResourceType.Binary,
      depth: 1,
      url: pathToFileURL(srcPath).toString(),
      refUrl: pathToFileURL(srcPath).toString(),
      localSrcRoot: pathToFileURL(tmpRoot).href.slice('file:///'.length),
      localRoot,
      encoding: 'utf8'
    });

    const downloaded = await readOrCopyLocalResource(resource, {}, options());

    expect(downloaded).toBeDefined();
    if (!downloaded || downloaded === true) throw new Error('Expected a local resource body');
    expect(downloaded.body).toBe('body');
  });

  test.each(['index.html', 'index.htm'])('uses %s metadata for a directory input', async index => {
    const directory = path.join(tmpRoot, 'site');
    await fs.mkdir(directory);
    const input = path.join(directory, index);
    await fs.writeFile(input, '<html>fixture</html>');
    await fs.utimes(input, 1000000, 1000000);
    await fs.utimes(directory, 2000000, 2000000);
    const url = pathToFileURL(directory).href + '/';
    const res = createResource({type: ResourceType.Html, depth: 0, url, refUrl: url,
      localSrcRoot: pathToFileURL(tmpRoot).href.slice('file:///'.length), localRoot, encoding: 'utf8'});
    await readOrCopyLocalResource(res, {}, options());
    const actual = await fs.stat(input);
    expect(res.body).toBe('<html>fixture</html>');
    expect(res.meta.headers).toEqual({'content-length': String(actual.size),
      'last-modified': actual.mtime.toISOString()});
  });

  test('rejects streaming copy paths that escape localRoot', async () => {
    const srcPath = path.join(tmpRoot, 'source.bin');
    await fs.writeFile(srcPath, 'body');
    const resource = createResource({
      type: ResourceType.StreamingBinary,
      depth: 1,
      url: pathToFileURL(srcPath).toString(),
      refUrl: pathToFileURL(srcPath).toString(),
      localSrcRoot: pathToFileURL(tmpRoot).href.slice('file:///'.length),
      localRoot,
      encoding: null
    });
    resource.savePath = path.join('..', 'source.bin');

    await expect(readOrCopyLocalResource(resource, {}, options()))
      .rejects.toThrow('Resolved path escapes root');
  });
});

describe('local streaming save policies', () => {
  function sourceResource(srcPath: string) {
    const url = pathToFileURL(srcPath).href;
    return createResource({type: ResourceType.StreamingBinary, depth: 0,
      url, refUrl: url, localRoot,
      localSrcRoot: pathToFileURL(tmpRoot).href.slice('file:///'.length)});
  }

  function pipelineWith(policy: ExistingResourceFunc) {
    const configured = defaultDownloadOptions({...defaultLifeCycle(), ...options(), existingResource: policy});
    return new PipelineExecutorImpl(configured, configured.req, configured);
  }

  test.each(['skipSave', 'skip', 'ifModifiedSince'] as const)(
    'checks %s after source metadata without changing cached output', async action => {
      const source = path.join(tmpRoot, 'source.bin');
      await fs.writeFile(source, 'fresh local bytes');
      await fs.utimes(source, 1000000, 1000000);
      const sourceStat = await fs.stat(source);
      const res = sourceResource(source);
      const destination = path.join(localRoot, res.savePath);
      await fs.mkdir(path.dirname(destination), {recursive: true});
      await fs.writeFile(destination, 'cached local bytes');
      await fs.utimes(destination, 2000000, 2000000);
      const cachedStat = await fs.stat(destination);
      const policy = jest.fn<ExistingResourceFunc>().mockImplementation(context => {
        if (context.stage === 'download') return action === 'ifModifiedSince' ? action : 'overwrite';
        expect(context.localPath).toBe(destination);
        expect(context.res.meta.headers).toEqual({
          'last-modified': sourceStat.mtime.toISOString(),
          'content-length': String(sourceStat.size)
        });
        expect(readFileSync(destination, 'utf8')).toBe('cached local bytes');
        expect(statSync(destination).mtimeMs).toBe(cachedStat.mtimeMs);
        return action;
      });

      await expect(pipelineWith(policy).download(res)).resolves.toBeUndefined();

      expect(policy.mock.calls.map(([context]) => context.stage)).toEqual(['download', 'saveToDisk']);
      expect(await fs.readFile(destination, 'utf8')).toBe('cached local bytes');
      expect((await fs.stat(destination)).mtimeMs).toBe(cachedStat.mtimeMs);
    });

  test('copies a newer local source after the conditional save decision', async () => {
    const source = path.join(tmpRoot, 'source.bin');
    await fs.writeFile(source, 'newer local bytes');
    await fs.utimes(source, 2000000, 2000000);
    const res = sourceResource(source);
    const destination = path.join(localRoot, res.savePath);
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.writeFile(destination, 'cached local bytes');
    await fs.utimes(destination, 1000000, 1000000);
    const policy = jest.fn<ExistingResourceFunc>().mockReturnValue('ifModifiedSince');

    await expect(pipelineWith(policy).download(res)).resolves.toBe(true);

    expect(policy.mock.calls.map(([context]) => context.stage)).toEqual(['download', 'saveToDisk']);
    expect(await fs.readFile(destination, 'utf8')).toBe('newer local bytes');
  });

  test('copies a missing destination without calling the existing-file policy', async () => {
    const source = path.join(tmpRoot, 'source.bin');
    await fs.writeFile(source, 'new local bytes');
    const res = sourceResource(source);
    const policy = jest.fn<ExistingResourceFunc>().mockReturnValue('skipSave');

    await expect(pipelineWith(policy).download(res)).resolves.toBe(true);

    expect(policy).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(localRoot, res.savePath), 'utf8')).toBe('new local bytes');
    expect(res.meta.headers?.['content-length']).toBe(String(Buffer.byteLength('new local bytes')));
  });

  test('uses the exact copy destination when the save path contains encoded characters', async () => {
    const source = path.join(tmpRoot, 'source.bin');
    await fs.writeFile(source, 'source body');
    const res = sourceResource(source);
    res.savePath = 'encoded%20name.bin';
    const destination = path.join(localRoot, res.savePath);
    const decoded = path.join(localRoot, 'encoded name.bin');
    await fs.writeFile(destination, 'encoded cached bytes');
    await fs.writeFile(decoded, 'decoded sibling');
    const policy = jest.fn<ExistingResourceFunc>().mockImplementation(context => {
      expect(context.stage).toBe('saveToDisk');
      expect(context.localPath).toBe(destination);
      return 'skipSave';
    });
    const executor = pipelineWith(policy);

    await expect(readOrCopyLocalResourceWithSavePolicy(res, {}, options(), executor)).resolves.toBeUndefined();

    expect(policy).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(destination, 'utf8')).toBe('encoded cached bytes');
    expect(await fs.readFile(decoded, 'utf8')).toBe('decoded sibling');
  });

  test('rejects a missing source before evaluating save policy or changing output', async () => {
    const res = sourceResource(path.join(tmpRoot, 'missing.bin'));
    const destination = path.join(localRoot, res.savePath);
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.writeFile(destination, 'cached local bytes');
    const policy = jest.fn<ExistingResourceFunc>().mockReturnValue('skipSave');
    const executor = pipelineWith(policy);

    await expect(readOrCopyLocalResourceWithSavePolicy(res, {}, options(), executor))
      .rejects.toMatchObject({code: 'ENOENT'});

    expect(policy).not.toHaveBeenCalled();
    expect(await fs.readFile(destination, 'utf8')).toBe('cached local bytes');
  });

  test('preserves containment checks when a save policy is configured', async () => {
    const source = path.join(tmpRoot, 'source.bin');
    await fs.writeFile(source, 'source body');
    const res = sourceResource(source);
    res.savePath = '../outside.bin';
    const policy = jest.fn<ExistingResourceFunc>().mockReturnValue('skipSave');
    const executor = pipelineWith(policy);

    await expect(readOrCopyLocalResourceWithSavePolicy(res, {}, options(), executor))
      .rejects.toThrow('Resolved path escapes root');
    expect(policy).not.toHaveBeenCalled();
  });
});
