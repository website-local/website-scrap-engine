import type {SrcSetDefinition} from 'srcset';
import {parseSrcset, stringifySrcset} from 'srcset';
import {load} from 'cheerio';
import {sources as defaultSources} from '../sources.js';
import type {DownloadResource, SubmitResourceFunc} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import {processCssText} from './process-css.js';
import {error, skip} from '../logger/logger.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {parseHtml} from './adapters.js';
import type {Cheerio, CheerioStatic} from '../types.js';

type Writeable<T> = { -readonly [P in keyof T]: T[P] };
type WriteableSrcSet = Writeable<SrcSetDefinition>;

async function processHtmlDoc(
  options: StaticDownloadOptions,
  doc: CheerioStatic,
  res: DownloadResource,
  pipeline: PipelineExecutor,
  depth: number,
  resources: Resource[],
  refUrl: string,
  savePath: string | undefined,
  submit: SubmitResourceFunc
) {
  const sources: typeof defaultSources = options.sources || defaultSources;
  for (const {selector, attr, type} of sources) {
    const elements: Cheerio = doc(selector);
    for (let index = 0; index < elements.length; index++) {
      const elem = elements.eq(index);
      const attrValue: string | void = attr && elem.attr(attr);
      if (!attr || !attrValue) {
        // style block
        if (type === ResourceType.CssInline) {
          let content = elem.html();
          if (!content) continue;
          content = await processCssText(content, res, options,
            pipeline, depth, resources);
          elem.html(content);
        }
        continue;
      } else if (type === ResourceType.CssInline) {
        const content: string = await processCssText(attrValue, res, options,
          pipeline, depth, resources);
        elem.attr(attr, content);
        continue;
      }
      let links: string[], replaceValue: string | SrcSetDefinition[];
      if (attr === 'srcset') {
        try {
          replaceValue = parseSrcset(attrValue);
        } catch (e) {
          error.info('skipping invalid srcset', attrValue, e);
          // should invalid srcset being removed?
          continue;
        }
        links = replaceValue.map(e => e.url);
      } else {
        links = [attrValue];
        replaceValue = attrValue;
      }
      for (let linkIndex = 0, l = links.length; linkIndex < l; linkIndex++) {
        const originalLink: string = links[linkIndex];
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
        if (attr === 'srcset') {
          // 20241005: It's ok to do this
          // I've looked into the source code of srcset 5.0.1
          // and there is nothing preventing the return value to change
          (replaceValue as WriteableSrcSet[])[linkIndex].url = resource.replacePath;
        } else {
          replaceValue = resource.replacePath;
          // historical workaround here
          if (replaceValue === '.html' || replaceValue === '/.html') {
            replaceValue = '';
          }
        }
      }
      if (attr === 'srcset') {
        elem.attr(attr, stringifySrcset(replaceValue as SrcSetDefinition[]));
      } else if (attr) {
        elem.attr(attr, replaceValue as string);
      } else {
        error.warn('skip attr replace', links, replaceValue, refUrl);
      }
    }
  }
  const iframeSrcDocs = doc('iframe[srcdoc]');

  for (let index = 0; index < iframeSrcDocs.length; index++) {
    const elem = iframeSrcDocs.eq(index);
    const attrValue: string | void = elem.attr('srcdoc');
    if (!attrValue) {
      continue;
    }
    try {
      const iframeDoc = load(attrValue);
      await processHtmlDoc(options, iframeDoc, res, pipeline, depth, resources, refUrl, savePath, submit);
      const html = options.cheerioSerialize ?
        iframeDoc.html(options.cheerioSerialize) : iframeDoc.html();
      elem.attr('srcdoc', html);
    } catch (e) {
      error.info('can not parse iframe srcdoc', res.url, res.rawUrl, e);
    }
  }
}

export async function processHtml(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor
): Promise<DownloadResource | void> {
  if (res.type !== ResourceType.Html) {
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
  // resources from inline css
  const resources: Resource[] = [];
  await processHtmlDoc(options, doc, res, pipeline, depth, resources, refUrl, savePath, submit);
  if (resources.length) {
    submit(resources);
  }
  return res;
}

