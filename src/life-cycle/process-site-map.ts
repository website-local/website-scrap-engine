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

export const processSiteMap: ProcessResourceAfterDownloadFunc = async (
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> => {
  if (res.type !== ResourceType.SiteMap) {
    return res;
  }
  const $: CheerioStatic = cheerio.load(toString(res.body,
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
  let url: string | void, r: Resource | void, type: ResourceType | void;
  // noinspection DuplicatedCode
  for (let i = 0, l = urls.length; i < l; i++) {
    url = urls[i];
    url = await pipeline.linkRedirect(url, null, res);
    if (!url) continue;
    type = await pipeline.detectResourceType(url, ResourceType.Html, null, res);
    if (!type) continue;
    r = await pipeline.createResource(type, depth, url,
      res.url, res.localRoot, options.encoding[type]);
    if (!r) continue;
    r = await pipeline.processBeforeDownload(r, null, res, options);
    if (!r) continue;
    if (!r.shouldBeDiscardedFromDownload) {
      resources.push(r);
    }
  }
  await submit(resources);
  return res;
};
