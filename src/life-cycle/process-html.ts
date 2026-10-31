import type {SrcSetDefinition} from 'srcset';
import {parseSrcset, stringifySrcset} from 'srcset';
import {load} from '../cheerio.js';
import type {HtmlParserOptions} from '../cheerio.js';
import {sources as defaultSources} from '../sources.js';
import type {DownloadResource, SubmitResourceFunc} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import {processCssText} from './process-css.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {isPromiseLike} from '../util.js';
import {parseHtml} from './adapters.js';
import type {Cheerio, CheerioStatic} from '../types.js';

type Writeable<T> = { -readonly [P in keyof T]: T[P] };
type WriteableSrcSet = Writeable<SrcSetDefinition>;

async function processHtmlDoc(
  options: StaticDownloadOptions & HtmlParserOptions,
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
  let tagElements: Cheerio | undefined;
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const {selector, attr, type, tag} = sources[sourceIndex];
    // Built-in tag hints are prepared once. Custom selectors without a hint
    // keep ordinary queries, including when a hook changes a later selector.
    let elements: Cheerio;
    if (tag) {
      if (!tagElements) {
        // Query tag names together; evaluate each full selector in source order.
        const tags: string[] = [];
        for (let next = sourceIndex; next < sources.length; next++) {
          const tag = sources[next].tag;
          if (!tag) break;
          if (!tags.includes(tag)) tags.push(tag);
        }
        tagElements = doc(tags.join(','));
      }
      elements = tagElements.filter(selector);
    } else {
      tagElements = undefined;
      elements = doc(selector);
    }
    // Empty rows run no hooks or writes. A matching row can mutate any later
    // match, so do not retain its tag selection across processing or awaits.
    if (elements.length) tagElements = undefined;
    for (let index = 0; index < elements.length; index++) {
      const elem = elements.eq(index);
      const attrValue: string | void = attr && elem.attr(attr);
      if (!attr || !attrValue) {
        // style block
        if (type === ResourceType.CssInline) {
          const content = elem.html();
          if (!content) continue;
          const processed = await processCssText(content, res, options,
            pipeline, depth, resources);
          // Hooks can mutate the document while processing its CSS links.
          if (processed !== content || elem.html() !== content) elem.html(processed);
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
          pipeline.logger.info('system.error', 'skipping invalid srcset', attrValue, e);
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
        const redirected = pipeline.linkRedirect(originalLink, elem, res);
        const link = isPromiseLike(redirected) ? await redirected : redirected;
        if (!link) {
          if (pipeline.logger.isTraceEnabled()) {
            pipeline.logger.trace('system.skip', 'skip linkRedirect', originalLink, refUrl);
          }
          continue;
        }
        const detected = pipeline.detectResourceType(link, type, elem, res);
        const linkType = isPromiseLike(detected) ? await detected : detected;
        if (!linkType) {
          if (pipeline.logger.isTraceEnabled()) {
            pipeline.logger.trace('system.skip', 'skip detectResourceType',
              originalLink, link, refUrl);
          }
          continue;
        }
        const created = pipeline.createResource(
          linkType, depth, link, refUrl,
          res.localRoot, options.encoding[linkType],
          savePath, res.type);
        let resource = isPromiseLike(created) ? await created : created;
        if (!resource) {
          if (pipeline.logger.isTraceEnabled()) {
            pipeline.logger.trace('system.skip', 'skip generateSavePath',
              originalLink, link, linkType, refUrl);
          }
          continue;
        }
        const processed = pipeline.processBeforeDownload(resource, elem, res, options);
        resource = isPromiseLike(processed) ? await processed : processed;
        if (!resource) {
          if (pipeline.logger.isTraceEnabled()) {
            pipeline.logger.trace('system.skip', 'skip processBeforeDownload',
              originalLink, link, linkType, refUrl);
          }
          continue;
        }
        if (!resource.shouldBeDiscardedFromDownload) {
          submit(resource, res, pipeline);
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
      } else {
        elem.attr(attr, replaceValue as string);
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
    let iframeDoc: (CheerioStatic & {dispose?: () => void}) | undefined;
    try {
      iframeDoc = load(attrValue, undefined, undefined, options);
      await processHtmlDoc(options, iframeDoc, res, pipeline, depth, resources, refUrl, savePath, submit);
      const html = options.cheerioSerialize ?
        iframeDoc.html(options.cheerioSerialize) : iframeDoc.html();
      elem.attr('srcdoc', html);
    } catch (e) {
      pipeline.logger.info('system.error', 'can not parse iframe srcdoc', res.url, res.rawUrl, e);
    } finally { iframeDoc?.dispose?.(); }
  }
}

export async function processHtml(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions & HtmlParserOptions,
  pipeline: PipelineExecutor
): Promise<DownloadResource | void> {
  if (res.type !== ResourceType.Html) {
    return res;
  }
  const refUrl: string = res.redirectedUrl || res.url;
  const savePath = refUrl === res.url ? res.savePath : undefined;

  const depth: number = res.depth + 1;
  const doc = res.meta.doc ?? parseHtml(res, options);
  // resources from inline css
  const resources: Resource[] = [];
  await processHtmlDoc(options, doc, res, pipeline, depth, resources, refUrl, savePath, submit);
  if (resources.length) {
    submit(resources, res, pipeline);
  }
  return res;
}
