import path from 'node:path';
import URI from 'urijs';
import type {DownloadResource} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {ResourceBody, ResourceEncoding} from '../resource.js';
import {ResourceType, urlOfSavePath} from '../resource.js';
import {escapePath} from '../util.js';
import {writeFile} from '../io.js';
import type {PipelineExecutor} from './pipeline-executor.js';

export function getResourceBodyFromHtml(
  res: DownloadResource & { type: ResourceType.Html },
  options: StaticDownloadOptions
): ResourceBody {
  if (!res.meta.doc) {
    return res.body;
  }
  if (options.cheerioSerialize) {
    return res.meta.doc.html(options.cheerioSerialize);
  }
  return res.meta.doc.html();
}

export function redirectHtml(relativePath: string, encoding?: ResourceEncoding): string {
  // language=HTML
  return `<html lang="en">
<head>
<meta charset="${encoding || 'utf8'}">
<meta http-equiv="refresh" content="0; url=${relativePath}">
<script>location.replace('${relativePath}' + location.hash);</script>
<title>Redirecting</title>
</head>
</html>`;
}

export async function saveHtmlToDisk(
  res: DownloadResource,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> {
  if (res.type !== ResourceType.Html) {
    return res;
  }
  const localRoot: string = res.localRoot ?? options.localRoot;
  // https://github.com/website-local/website-scrap-engine/issues/174
  let mtime: number | void = void 0;
  if (options.preferRemoteLastModifiedTime && res.meta?.headers?.['last-modified']) {
    mtime = Date.parse(res.meta.headers?.['last-modified']);
  }
  if (res.redirectedUrl && res.redirectedUrl !== res.url) {
    if (res.redirectedSavePath) {
      if (res.redirectedSavePath !== res.savePath) {
        const replaceUri = URI(urlOfSavePath(res.redirectedSavePath))
          .relativeTo(urlOfSavePath(res.savePath));
        const relativePath: string = escapePath(replaceUri.toString());
        await writeFile(path.join(localRoot, decodeURI(res.savePath)),
          redirectHtml(relativePath, res.encoding), res.encoding, mtime);
        const body: ResourceBody = getResourceBodyFromHtml(res, options);
        await writeFile(path.join(localRoot, decodeURI(res.redirectedSavePath)),
          body, res.encoding, mtime);
      } else {
        const body: ResourceBody = getResourceBodyFromHtml(res, options);
        const filePath: string = path.join(localRoot, decodeURI(res.savePath));
        await writeFile(filePath, body, res.encoding, mtime);
      }
      return;
    }
    const redirectResource = await pipeline.createResource(ResourceType.Html,
      res.depth, res.redirectedUrl, res.url, localRoot,
      undefined, res.refSavePath);
    if (redirectResource.replacePath) {
      const relativePath: string = escapePath(redirectResource.replacePath);
      const savePath = decodeURI(res.savePath);
      await writeFile(path.join(localRoot, savePath),
        redirectHtml(relativePath, res.encoding), res.encoding, mtime);
      const redirectedResource = await pipeline.createResource(ResourceType.Html,
        res.depth, res.redirectedUrl, res.refUrl, res.localRoot,
        res.encoding, undefined, ResourceType.Html);
      const redirectedSavePath = decodeURI(redirectedResource.savePath);
      const body: ResourceBody = getResourceBodyFromHtml(res, options);
      await writeFile(path.join(localRoot, redirectedSavePath), body, res.encoding, mtime);
      return;
    }
  }
  const body: ResourceBody = getResourceBodyFromHtml(res, options);
  const filePath: string = path.join(localRoot, decodeURI(res.savePath));
  await writeFile(filePath, body, res.encoding, mtime);
  return;
}
