import {skip} from '../logger/logger.js';
import type {SourceDefinition} from '../sources.js';
import type {AsyncResult, DownloadResource, SubmitResourceFunc} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {HtmlParserOptions} from '../cheerio.js';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {parseHtml} from './adapters.js';
import {isPromiseLike} from '../util.js';
import {getResourceBodyFromHtml} from './save-html-to-disk.js';
import type {Cheerio} from '../types.js';

const svgSelectors: SourceDefinition[] = [
  {selector: '*[xlink\\:href]', attr: 'xlink:href', type: ResourceType.Binary},
  {selector: '*[href]', attr: 'href', type: ResourceType.Binary},
];

export function processSvg(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions & HtmlParserOptions,
  pipeline: PipelineExecutor): AsyncResult<DownloadResource | void> {
  if (res.type !== ResourceType.Svg) {
    return res;
  }
  return processSvgResource(res, submit, options, pipeline);
}

async function processSvgResource(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions & HtmlParserOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> {
  const refUrl: string = res.redirectedUrl || res.url;
  const savePath = refUrl === res.url ? res.savePath : undefined;

  const depth: number = res.depth + 1;
  const doc = res.meta.doc ?? parseHtml(res, options);
  for (const {selector, attr, type} of svgSelectors) {
    const elements: Cheerio = doc(selector);
    for (let index = 0; index < elements.length; index++) {
      const elem = elements.eq(index);
      const originalLink = attr && elem.attr(attr);
      if (!attr || !originalLink) {
        continue;
      }
      const redirected = pipeline.linkRedirect(originalLink, elem, res);
      const link = isPromiseLike(redirected) ? await redirected : redirected;
      if (!link) {
        if (skip.isTraceEnabled()) {
          skip.trace('skip linkRedirect', originalLink, refUrl);
        }
        continue;
      }
      const detected = pipeline.detectResourceType(link, type, elem, res);
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
      elem.attr(attr, resource.replacePath);
    }
  }
  res.body = getResourceBodyFromHtml(res, options);
  return res;
}
