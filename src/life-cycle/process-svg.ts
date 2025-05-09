import type {SourceDefinition} from '../sources.js';
import type {DownloadResource, SubmitResourceFunc} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import {error, skip} from '../logger/logger.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {parseHtml} from './adapters.js';
import {getResourceBodyFromHtml} from './save-html-to-disk.js';
import type {Cheerio, CheerioStatic} from '../types.js';

const svgSelectors: SourceDefinition[] = [
  {selector: '*[xlink\\:href]', attr: 'xlink:href', type: ResourceType.Binary},
  {selector: '*[href]', attr: 'href', type: ResourceType.Binary},
];

export async function processSvg(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> {
  if (res.type !== ResourceType.Svg) {
    return res;
  }
  const refUrl: string = res.redirectedUrl || res.url;
  const savePath = refUrl === res.url ? res.savePath : undefined;
  // useless since processRedirectedUrl enabled by default
  // refUrl = await pipeline.linkRedirect(refUrl, null, res) || refUrl;

  const depth: number = res.depth + 1;
  let doc: CheerioStatic | void = res.meta.doc;
  if (!doc) {
    res.meta.doc = doc = parseHtml(res, options);
  }
  for (const {selector, attr, type} of svgSelectors) {
    const elements: Cheerio = doc(selector);
    for (let index = 0; index < elements.length; index++) {
      const elem = elements.eq(index);
      const attrValue: string | void = attr && elem.attr(attr);
      if (!attr || !attrValue) {
        continue;
      }
      const originalLink: string = attrValue;
      let replaceValue: string = originalLink;
      // skip empty links
      if (!originalLink) {
        continue;
      }
      const link: string | void =
        await pipeline.linkRedirect(originalLink, elem, res);
      if (!link) {
        if (skip.isTraceEnabled()) {
          skip.trace('skip linkRedirect', originalLink, refUrl);
        }
        continue;
      }
      const linkType: ResourceType | void =
        await pipeline.detectResourceType(link, type, elem, res);
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
      replaceValue = resource.replacePath;
      // historical workaround here
      if (replaceValue === '.html' || replaceValue === '/.html') {
        replaceValue = '';
      }
      if (attr) {
        elem.attr(attr, replaceValue as string);
      } else {
        error.warn('skip attr replace', originalLink, replaceValue, refUrl);
      }
    }
  }
  res.body = getResourceBodyFromHtml(res, options);
  return res;
}

