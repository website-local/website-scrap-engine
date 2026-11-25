import {disposeHtmlResource} from '../cheerio.js';
import type {AsyncResult, DownloadResource} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {Resource, ResourceBody, ResourceEncoding} from '../resource.js';
import {ResourceType, replacementUri} from '../resource.js';
import {safeJoin, writeFile} from '../io.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {disposeRedirectResource, releaseResourceBody} from './save-resource-to-disk.js';

export function getResourceBodyFromHtml(
  res: DownloadResource & { type: ResourceType.Html | ResourceType.Svg },
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
  const jsPath = relativePath.replace(/'/g, '\\\'');
  const htmlPath = relativePath.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // language=HTML
  return `<html lang="en">
<head>
<meta charset="${encoding || 'utf8'}">
<meta http-equiv="refresh" content="0; url=${htmlPath}">
<script>location.replace('${jsPath}' + location.hash);</script>
<title>Redirecting</title>
</head>
</html>`;
}

export function saveHtmlToDisk(
  res: DownloadResource,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): AsyncResult<DownloadResource | void> {
  if (res.type !== ResourceType.Html) {
    return res;
  }
  return saveHtmlResourceToDisk(res, options, pipeline);
}

async function saveHtmlResourceToDisk(
  res: DownloadResource,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> {
  let redirectResource: Resource | undefined;
  let redirectedResource: Resource | undefined;
  let failed = false;
  try {
    const localRoot: string = res.localRoot ?? options.localRoot;
    // https://github.com/website-local/website-scrap-engine/issues/174
    let mtime: number | undefined;
    if (options.preferRemoteLastModifiedTime && res.meta?.headers?.['last-modified']) {
      mtime = Date.parse(res.meta.headers?.['last-modified']) / 1000;
    }
    if (res.redirectedUrl && res.redirectedUrl !== res.url) {
      if (res.redirectedSavePath) {
        if (res.redirectedSavePath !== res.savePath) {
          const relativePath = replacementUri(res.redirectedSavePath, res.savePath).toString();
          await writeFile(safeJoin(localRoot, decodeURI(res.savePath)),
            redirectHtml(relativePath, res.encoding), res.encoding, mtime);
          const body: ResourceBody = getResourceBodyFromHtml(res, options);
          await writeFile(safeJoin(localRoot, decodeURI(res.redirectedSavePath)),
            body, res.encoding, mtime);
        } else {
          const body: ResourceBody = getResourceBodyFromHtml(res, options);
          const filePath: string = safeJoin(localRoot, decodeURI(res.savePath));
          await writeFile(filePath, body, res.encoding, mtime);
        }
        return;
      }
      redirectResource = await pipeline.createResource(ResourceType.Html,
        res.depth, res.redirectedUrl, res.url, localRoot,
        undefined, res.refSavePath);
      if (redirectResource.replacePath) {
        const relativePath: string = redirectResource.replacePath;
        const savePath = decodeURI(res.savePath);
        await writeFile(safeJoin(localRoot, savePath),
          redirectHtml(relativePath, res.encoding), res.encoding, mtime);
        redirectedResource = await pipeline.createResource(ResourceType.Html,
          res.depth, res.redirectedUrl, res.refUrl, res.localRoot,
          res.encoding, undefined, ResourceType.Html);
        const redirectedSavePath = decodeURI(redirectedResource.savePath);
        const body: ResourceBody = getResourceBodyFromHtml(res, options);
        await writeFile(safeJoin(localRoot, redirectedSavePath), body, res.encoding, mtime);
        return;
      }
    }
    const body: ResourceBody = getResourceBodyFromHtml(res, options);
    const filePath: string = safeJoin(localRoot, decodeURI(res.savePath));
    await writeFile(filePath, body, res.encoding, mtime);
    return;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      if (redirectedResource) {
        const disposing = disposeRedirectResource(redirectedResource, res, redirectResource);
        if (disposing) await disposing;
      }
    } finally {
      try {
        if (redirectResource) {
          const disposing = disposeRedirectResource(redirectResource, res);
          if (disposing) await disposing;
        }
      } finally {
        const disposing = disposeHtmlResource(res);
        if (disposing) await disposing;
      }
    }
    if (!failed) releaseResourceBody(res);
  }
}
