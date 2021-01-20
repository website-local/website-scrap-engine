import path from 'path';
import type {DownloadResource} from './types';
import type {StaticDownloadOptions} from '../options';
import type {ResourceBody} from '../resource';
import {writeFile} from '../io';
import type {PipelineExecutor} from './pipeline-executor';

export async function saveResourceToDisk(
  res: DownloadResource,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> {
  const localRoot: string = res.localRoot ?? options.localRoot;
  if (res.redirectedUrl && res.redirectedUrl !== res.url) {
    const redirectResource = await pipeline.createResource(res.type,
      res.depth, res.url, res.redirectedUrl, localRoot,
      res.encoding, undefined, res.type);
    if (redirectResource.replacePath) {
      const savePath = decodeURI(res.savePath);
      await writeFile(path.join(localRoot, savePath), res.body, res.encoding);
      const redirectedResource = await pipeline.createResource(res.type,
        res.depth, res.redirectedUrl, res.refUrl, res.localRoot,
        res.encoding, undefined, res.type);
      const redirectedSavePath = decodeURI(redirectedResource.savePath);
      await writeFile(path.join(localRoot, redirectedSavePath), res.body, res.encoding);
      return;
    }
  }
  const body: ResourceBody = res.meta.doc ? res.meta.doc.toString() : res.body;
  const filePath: string = path.join(localRoot, decodeURI(res.savePath));
  await writeFile(filePath, body, res.encoding);
  return;
}
