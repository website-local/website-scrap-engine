import {DownloadResource, SaveToDiskFunc} from './types';
import {StaticDownloadOptions} from '../options';
import {ResourceBody, ResourceType} from '../resource';
import path from 'path';
import {escapePath} from '../util';
import {writeFile} from '../io';
import {PipelineExecutor} from './pipeline-executor';

export const getResourceBodyFromHtml = (
  res: DownloadResource & { type: ResourceType.Html },
  options: StaticDownloadOptions
): ResourceBody => {
  if (!res.meta.doc) {
    return res.body;
  }
  if (options.cheerioSerialize) {
    return res.meta.doc.html(options.cheerioSerialize);
  }
  return res.meta.doc.html();
};

export const saveHtmlToDisk: SaveToDiskFunc = async (
  res: DownloadResource,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> => {
  if (res.type !== ResourceType.Html) {
    return res;
  }
  const localRoot: string = res.localRoot ?? options.localRoot;
  if (res.redirectedUrl && res.redirectedUrl !== res.downloadLink) {
    const redirectResource = await pipeline.createResource(ResourceType.Html,
      res.depth, res.url, res.redirectedUrl, localRoot);
    if (redirectResource.replacePath) {
      const relativePath: string = escapePath(redirectResource.replacePath);
      const savePath = decodeURI(res.savePath);
      await writeFile(path.join(localRoot, savePath), `<html lang="en">
<head>
<meta charset="${res.encoding || 'utf8'}">
<meta http-equiv="refresh" content="0; url=${relativePath}">
<script>location.replace('${relativePath}');</script>
<title>Redirecting</title>
</head>
</html>`, res.encoding);
      const redirectedResource = await pipeline.createResource(ResourceType.Html,
        res.depth, res.redirectedUrl, res.refUrl, res.localRoot, res.encoding);
      const redirectedSavePath = decodeURI(redirectedResource.savePath);
      const body: ResourceBody = getResourceBodyFromHtml(res, options);
      await writeFile(path.join(localRoot, redirectedSavePath), body, res.encoding);
      return;
    }
  }
  const body: ResourceBody = res.meta.doc ? res.meta.doc.html() : res.body;
  const filePath: string = path.join(localRoot, decodeURI(res.savePath));
  await writeFile(filePath, body, res.encoding);
  return;
};
