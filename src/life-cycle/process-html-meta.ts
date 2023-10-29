import type {DownloadResource, SubmitResourceFunc} from './types';
import type {StaticDownloadOptions} from '../options';
import type {PipelineExecutor} from './pipeline-executor';
import {Resource, ResourceType} from '../resource';
import {parseHtml} from './adapters';
import {skip} from '../logger/logger';

/**
 * Originally create by https://github.com/stevenvachon at
 * https://github.com/stevenvachon/http-equiv-refresh
 * MIT license
 */
const META_REFRESH_PATTERN =
  /^\s*(\d+)(?:\s*;(?:\s*url\s*=)?\s*(?:["']\s*(.*?)\s*['"]|(.*?)))?\s*$/i;

export async function processHtmlMetaRefresh(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor
): Promise<DownloadResource> {

  if (res.type !== ResourceType.Html) {
    return res;
  }
  if (!res.meta.doc) {
    res.meta.doc = parseHtml(res, options);
  }
  const $ = res.meta.doc;

  const metaLinks = $('meta[http-equiv="refresh"][content]');
  if (metaLinks.length) {
    const refUrl: string = res.redirectedUrl || res.url;
    const savePath = refUrl === res.url ? res.savePath : undefined;

    const depth: number = res.depth + 1;

    for (let index = 0; index < metaLinks.length; index++) {
      const elem = metaLinks.eq(index);
      const attrValue: string | void = elem.attr('content');
      if (!attrValue) {
        continue;
      }
      const match = META_REFRESH_PATTERN.exec(attrValue);
      if (!match) {
        continue;
      }
      const originalLink = match[2] || match[3];
      if (!originalLink) {
        continue;
      }
      const link: string | void =
        await pipeline.linkRedirect(originalLink, elem, res);
      if (!link) {
        continue;
      }

      const linkType: ResourceType | void =
        await pipeline.detectResourceType(link, ResourceType.Html, elem, res);
      if (!linkType) {
        if (skip.isTraceEnabled()) {
          skip.trace('skip detectResourceType',
            originalLink, link, refUrl);
        }
        continue;
      }
      let resource: Resource | void = await pipeline.createResource(
        linkType, depth, link, refUrl,
        res.localRoot, options.encoding[linkType],
        savePath, res.type);
      resource = await pipeline.processBeforeDownload(resource, elem, res, options);
      if (!resource) {
        if (skip.isTraceEnabled()) {
          skip.trace('skip processBeforeDownload',
            originalLink, link, linkType, refUrl);
        }
        continue;
      }
      if (!resource.shouldBeDiscardedFromDownload) {
        submit(resource);
      }
      elem.attr('content', attrValue.replace(originalLink, resource.replacePath));
    }
  }

  return res;
}
