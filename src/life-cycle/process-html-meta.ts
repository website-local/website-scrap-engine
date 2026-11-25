import type {HtmlParserOptions} from '../cheerio.js';
import {skip} from '../logger/logger.js';
import type {AsyncResult, DownloadResource, SubmitResourceFunc} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import {parseHtml} from './adapters.js';
import {isPromiseLike} from '../util.js';

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

export function processHtmlMetaRefresh(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions & HtmlParserOptions,
  pipeline: PipelineExecutor
): AsyncResult<DownloadResource> {
  if (res.type !== ResourceType.Html) {
    return res;
  }
  return processHtmlMetaRefreshResource(res, submit, options, pipeline);
}

async function processHtmlMetaRefreshResource(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions & HtmlParserOptions,
  pipeline: PipelineExecutor
): Promise<DownloadResource> {
  const $ = res.meta.doc ?? parseHtml(res, options);

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
      const redirected = pipeline.linkRedirect(originalLink, elem, res);
      const link = isPromiseLike(redirected) ? await redirected : redirected;
      if (!link) {
        continue;
      }

      const detected = pipeline.detectResourceType(link, ResourceType.Html, elem, res);
      const linkType = isPromiseLike(detected) ? await detected : detected;
      if (!linkType) {
        if (skip.isTraceEnabled()) {
          skip.trace('skip detectResourceType',
            originalLink, link, refUrl);
        }
        continue;
      }
      const created = pipeline.createResource(
        linkType, depth, link, refUrl,
        res.localRoot, options.encoding[linkType],
        savePath, res.type);
      let resource: Resource | void = isPromiseLike(created) ? await created : created;
      if (!resource) {
        if (skip.isTraceEnabled()) {
          skip.trace('skip generateSavePath',
            originalLink, link, linkType, refUrl);
        }
        continue;
      }
      const processed = pipeline.processBeforeDownload(resource, elem, res, options);
      resource = isPromiseLike(processed) ? await processed : processed;
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
