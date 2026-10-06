import type {DownloadResource, SubmitResourceFunc} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import {parseHtml} from './adapters.js';
import {skip} from '../logger/logger.js';

/**
 * Preserve extraction from stevenvachon/http-equiv-refresh (MIT) without its
 * overlapping whitespace backtracking.
 */
// Every fast-path repetition is bounded. Long whitespace, delays and targets
// use the general linear parser instead of spending time on failed matches.
const shortRefresh = /^\s{0,32}\d{1,16}\s{0,32};\s{0,32}(?:url\s{0,32}=\s{0,32})?["']\s{0,32}([^"'\r\n\u2028\u2029]{0,256})["']\s{0,32}$/i;

export function parseRefreshLink(value: string): string | undefined {
  if (value.endsWith('"') || value.endsWith('\'')) {
    const short = shortRefresh.exec(value);
    if (short) return short[1].trim() || undefined;
  }
  const prefix = /^\s*\d+\s*;\s*(?:url\s*=\s*)?/i.exec(value);
  if (!prefix) return;
  const target = value.slice(prefix[0].length).trimEnd();
  const first = target[0], last = target.at(-1);
  if ((first === '"' || first === '\'') && (last === '"' || last === '\'') && target.length > 1) {
    const quoted = target.slice(1, -1).trim();
    if (!/[\r\n\u2028\u2029]/.test(quoted)) return quoted || undefined;
  }
  return target && !/[\r\n\u2028\u2029]/.test(target) ? target : undefined;
}

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
      const originalLink = parseRefreshLink(attrValue);
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
      if (!resource) {
        if (skip.isTraceEnabled()) {
          skip.trace('skip generateSavePath',
            originalLink, link, linkType, refUrl);
        }
        continue;
      }
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
      // Use a positional splice rather than String.prototype.replace: the
      // replacement string may contain '$' sequences ($&, $1, ...) that
      // replace() would interpret and corrupt the rewritten path.
      const linkStart = attrValue.indexOf(originalLink);
      if (linkStart !== -1) {
        elem.attr('content',
          attrValue.slice(0, linkStart) + resource.replacePath +
          attrValue.slice(linkStart + originalLink.length));
      }
    }
  }

  return res;
}
