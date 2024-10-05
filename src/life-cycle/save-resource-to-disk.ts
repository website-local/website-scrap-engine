import path from 'path';
import type {DownloadResource} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import {writeFile} from '../io.js';
import type {PipelineExecutor} from './pipeline-executor.js';

export async function saveResourceToDisk(
  res: DownloadResource,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> {
  const localRoot: string = res.localRoot ?? options.localRoot;
  // https://github.com/website-local/website-scrap-engine/issues/174
  let mtime: number | void = void 0;
  if (options.preferRemoteLastModifiedTime && res.meta?.headers?.['last-modified']) {
    mtime = Date.parse(res.meta.headers?.['last-modified']);
  }
  if (res.redirectedUrl && res.redirectedUrl !== res.url) {
    if (res.redirectedSavePath) {
      if (res.redirectedSavePath !== res.savePath) {
        const redirectedSavePath = decodeURI(res.redirectedSavePath);
        await writeFile(path.join(localRoot, redirectedSavePath), res.body,
          res.encoding, mtime);
      }
      const savePath = decodeURI(res.savePath);
      await writeFile(path.join(localRoot, savePath), res.body, res.encoding, mtime);
      return;
    }
    const redirectResource = await pipeline.createResource(res.type,
      res.depth, res.url, res.redirectedUrl, localRoot,
      res.encoding, undefined, res.type);
    // maybe we can try module:fs/promises.symlink first
    if (redirectResource.replacePath) {
      const savePath = decodeURI(res.savePath);
      await writeFile(path.join(localRoot, savePath), res.body, res.encoding, mtime);
      const redirectedResource = await pipeline.createResource(res.type,
        res.depth, res.redirectedUrl, res.refUrl, res.localRoot,
        res.encoding, undefined, res.type);
      const redirectedSavePath = decodeURI(redirectedResource.savePath);
      await writeFile(path.join(localRoot, redirectedSavePath), res.body,
        res.encoding, mtime);
      return;
    }
  }
  const filePath: string = path.join(localRoot, decodeURI(res.savePath));
  await writeFile(filePath, res.body, res.encoding, mtime);
  return;
}
