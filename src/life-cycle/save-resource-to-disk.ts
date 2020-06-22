import {DownloadResource, PipelineExecutor, SaveToDiskFunc} from '../pipeline';
import {StaticDownloadOptions} from '../options';
import {ResourceBody, ResourceType} from '../resource';
import path from 'path';
import {writeFile} from '../util';

export const saveResourceToDisk: SaveToDiskFunc = async (
  res: DownloadResource,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> => {
  const localRoot: string = res.localRoot ?? options.localRoot;
  if (res.redirectedUrl && res.redirectedUrl !== res.downloadLink) {
    const redirectResource = await pipeline.createResource(ResourceType.Html,
      res.depth, res.url, res.redirectedUrl, localRoot);
    if (redirectResource.replacePath) {
      const savePath = decodeURI(res.savePath);
      await writeFile(path.join(localRoot, savePath), res.body, res.encoding);
      const redirectedResource = await pipeline.createResource(ResourceType.Html,
        res.depth, res.redirectedUrl, res.refUrl, res.localRoot, res.encoding);
      const redirectedSavePath = decodeURI(redirectedResource.savePath);
      await writeFile(path.join(localRoot, redirectedSavePath), res.body, res.encoding);
      return;
    }
  }
  const body: ResourceBody = res.meta.doc ? res.meta.doc.toString() : res.body;
  const filePath: string = path.join(localRoot, decodeURI(res.savePath));
  await writeFile(filePath, body, res.encoding);
  return;
};
