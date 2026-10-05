import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {promises as fs} from 'node:fs';
import {join, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {defaultDownloadOptions} from '../../src/options.js';
import {createResource, ResourceType} from '../../src/resource.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {localUrlMounts} from '../../src/life-cycle/local-url-mount.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import type {ExistingResourceAction} from '../../src/life-cycle/types.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(process.cwd(), '.wse-copy-test-')); });
afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(root, {recursive: true, force: true});
});

async function setup(kind: string, action: ExistingResourceAction = 'overwrite') {
  const sourceRoot = join(root, 'source');
  const output = join(root, 'output');
  await fs.mkdir(sourceRoot);
  const source = join(sourceRoot, 'asset.bin');
  await fs.writeFile(source, 'new complete');
  await fs.utimes(source, 100, 100);
  const url = kind === 'file' ? pathToFileURL(source).href : 'https://example.test/asset.bin';
  const resource = createResource({type: ResourceType.StreamingBinary, depth: 0,
    url, refUrl: url, localRoot: output, localSrcRoot: pathToFileURL(sourceRoot).href.slice('file:///'.length), encoding: null});
  const destination = join(output, resource.savePath);
  await fs.mkdir(dirname(destination), {recursive: true});
  await fs.writeFile(destination, 'cached');
  await fs.utimes(destination, 200, 200);
  const lifeCycle = defaultLifeCycle();
  if (kind === 'mount') lifeCycle.download.unshift(localUrlMounts([
    {root: sourceRoot, urlPrefix: 'https://example.test/'}
  ]));
  const stages: string[] = [];
  lifeCycle.existingResource = context => {
    stages.push(context.stage);
    return context.stage === 'download' ? 'overwrite' : action;
  };
  const options = defaultDownloadOptions({...lifeCycle, localRoot: output});
  const controller = new AbortController();
  const pipeline = new PipelineExecutorImpl(options, options.req, options, controller.signal);
  return {resource, destination, pipeline, controller, stages};
}

describe.each(['file', 'mount'])('staged %s copy', kind => {
  test.each(['skipSave', 'overwrite', 'ifModifiedSince'] as const)('honors save-stage %s', async action => {
    const {resource, destination, pipeline, stages} = await setup(kind, action);
    await pipeline.download(resource);
    expect(stages).toEqual(['download', 'saveToDisk']);
    expect(await fs.readFile(destination, 'utf8')).toBe(action === 'overwrite' ? 'new complete' : 'cached');
    expect(await fs.readdir(dirname(destination))).toEqual(['asset.bin']);
  });

  test('refuses to copy through a symlinked output directory', async () => {
    const {resource, pipeline} = await setup(kind);
    const outside = join(root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, join(resource.localRoot, 'escape'), 'dir');
    resource.savePath = 'escape/asset.bin';
    await expect(pipeline.download(resource)).rejects.toThrow('symlink');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  test.each(['error', 'cancel'])('%s during copying preserves the cache', async failure => {
    const {resource, destination, pipeline, controller} = await setup(kind);
    jest.spyOn(fs, 'copyFile').mockImplementation(async (_source, staging) => {
      await fs.writeFile(staging, 'partial');
      expect(await fs.readFile(destination, 'utf8')).toBe('cached');
      if (failure === 'error') throw new Error('copy failed');
      controller.abort(new Error('copy cancelled'));
    });
    await expect(pipeline.download(resource)).rejects.toThrow(
      failure === 'error' ? 'copy failed' : 'copy cancelled');
    expect(await fs.readFile(destination, 'utf8')).toBe('cached');
    expect(await fs.readdir(dirname(destination))).toEqual(['asset.bin']);
  });
});
