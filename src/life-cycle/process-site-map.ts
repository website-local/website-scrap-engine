import {load} from 'cheerio';
import type {DownloadResource, SubmitResourceFunc} from './types';
import type {StaticDownloadOptions} from '../options';
import {Resource, ResourceType} from '../resource';
import {toString} from '../util';
import type {PipelineExecutor} from './pipeline-executor';
import type {CheerioStatic} from '../types';

export async function processSiteMap(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> {
  if (res.type !== ResourceType.SiteMap) {
    return res;
  }
  const $: CheerioStatic = load(toString(res.body,
    res.encoding || options.encoding[ResourceType.SiteMap] || 'utf8'));
  const urlSet: Set<string> = new Set();
  const depth: number = res.depth + 1;
  // noinspection CssInvalidHtmlTagReference
  $('urlset url loc').each((index, obj) => {
    let url: string = $(obj).text();
    if (url && (url = url.trim()) && !urlSet.has(url)) {
      urlSet.add(url);
    }
  });
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
  await submit(resources);
  return res;
}
