import {sources} from '../sources';
import srcset, {SrcSetDefinition} from 'srcset';
import cheerio from 'cheerio';
import {
  DownloadResource,
  PipelineExecutor,
  ProcessResourceAfterDownloadFunc,
  SubmitResourceFunc
} from '../pipeline';
import {StaticDownloadOptions} from '../options';
import {Resource, ResourceType} from '../resource';
import {toString} from '../util';
import {processCssText} from './process-css';
import {error, skip} from '../logger/logger';

export const processHtml: ProcessResourceAfterDownloadFunc = async (
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> => {
  if (res.type !== ResourceType.Html) {
    return res;
  }
  let refUrl: string = res.redirectedUrl || res.url;
  refUrl = await pipeline.linkRedirect(refUrl, null, res) || refUrl;

  const depth: number = res.depth + 1;
  const resources: Resource[] = [];
  let doc: CheerioStatic | void = res.meta.doc;
  if (!doc) {
    res.meta.doc = doc = cheerio.load(toString(res.body,
      res.encoding || options.encoding[res.type] || 'utf8'));
  }
  for (const {selector, attr, type} of sources) {
    const elements: Cheerio = doc(selector);
    for (let index = 0; index < elements.length; index++) {
      const elem = elements.eq(index);
      const attrValue: string | void = attr && elem.attr(attr);
      if (!attr || !attrValue) {
        if (type === ResourceType.CssInline) {
          let content = elem.html();
          if (!content) continue;
          content = await processCssText(content, res, options,
            pipeline, depth, resources);
          elem.html(content);
        }
        continue;
      }
      let links: string[], replaceValue: string | SrcSetDefinition[];
      if (attr === 'srcset') {
        replaceValue = srcset.parse(attrValue);
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
        let resource: Resource | void = pipeline.createResource(type, depth,
          link, refUrl, res.localRoot, options.encoding[type]);
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
          (replaceValue as SrcSetDefinition[])[linkIndex].url = resource.replacePath;
        } else {
          replaceValue = resource.replacePath;
          // historical workaround here
          if (replaceValue === '.html' || replaceValue === '/.html') {
            replaceValue = '';
          }
        }
      }
      if (attr === 'srcset') {
        elem.attr(attr, srcset.stringify(replaceValue as SrcSetDefinition[]));
      } else if (attr) {
        elem.attr(attr, replaceValue as string);
      } else {
        error.warn('skip attr replace', links, replaceValue, refUrl);
      }
    }
  }
  return res;
};

