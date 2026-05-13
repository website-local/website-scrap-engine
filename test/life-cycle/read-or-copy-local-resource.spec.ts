import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readOrCopyLocalResource} from '../../src/life-cycle/read-or-copy-local-resource.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {StaticDownloadOptions} from '../../src/options.js';

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
      localSrcRoot: tmpRoot,
      localRoot,
      encoding: 'utf8'
    });

    const downloaded = await readOrCopyLocalResource(resource, {}, options());

    expect(downloaded).toBeDefined();
    expect(downloaded!.body).toBe('body');
  });

  test('rejects streaming copy paths that escape localRoot', async () => {
    const srcPath = path.join(tmpRoot, 'source.bin');
    await fs.writeFile(srcPath, 'body');
    const resource = createResource({
      type: ResourceType.StreamingBinary,
      depth: 1,
      url: pathToFileURL(srcPath).toString(),
      refUrl: pathToFileURL(srcPath).toString(),
      localSrcRoot: tmpRoot,
      localRoot,
      encoding: null
    });
    resource.savePath = path.join('..', 'source.bin');

    await expect(readOrCopyLocalResource(resource, {}, options()))
      .rejects.toThrow('Resolved path escapes root');
  });
});
