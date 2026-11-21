import {parseHtml} from './adapters.js';
import type {AsyncResult, DownloadResource, SubmitResourceFunc} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {HtmlParserOptions} from '../cheerio.js';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import type {CheerioStatic} from '../types.js';

export function processSiteMap(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions & HtmlParserOptions,
  pipeline: PipelineExecutor): AsyncResult<DownloadResource | void> {
  if (res.type !== ResourceType.SiteMap) {
    return res;
  }
  return processSiteMapResource(res, submit, options, pipeline);
}

async function processSiteMapResource(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions & HtmlParserOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> {
  const $: CheerioStatic = res.meta.doc ?? parseHtml(res, options);
  const urlSet: Set<string> = new Set();
  const depth: number = res.depth + 1;
  // noinspection CssInvalidHtmlTagReference
  const locations = $('urlset url loc');
  for (let index = 0; index < locations.length; index++) {
    let url = locations.eq(index).text();
    if (url && (url = url.trim()) && !urlSet.has(url)) {
      urlSet.add(url);
    }
  }
  const urls: string[] = Array.from(urlSet);
  const resources: Resource[] = [];
  let url: string | void, r: Resource | void;
  // noinspection DuplicatedCode
  for (let i = 0, l = urls.length; i < l; i++) {
    url = urls[i];
    r = await pipeline.createAndProcessResource(
      url, ResourceType.Html, depth, null, res);
    if (!r) continue;
    if (!r.shouldBeDiscardedFromDownload) {
      resources.push(r);
    }
  }
  submit(resources);
  return res;
}
