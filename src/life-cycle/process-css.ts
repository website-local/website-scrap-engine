import parseCssUrls from 'css-url-parser';
import {
  DownloadResource,
  PipelineExecutor,
  ProcessResourceAfterDownloadFunc,
  SubmitResourceFunc
} from '../pipeline';
import {StaticDownloadOptions} from '../options';
import {Resource, ResourceType} from '../resource';
import {toString} from '../util';

export async function processCssText(
  cssText: string,
  res: DownloadResource,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor,
  depth: number,
  resources: Resource[]): Promise<string> {
  const cssUrls: string[] = parseCssUrls(cssText);
  let url: string | void, rawUrl: string, r: Resource | void,
    type: ResourceType | void;
  // noinspection DuplicatedCode
  for (let i = 0, l = cssUrls.length; i < l; i++) {
    rawUrl = cssUrls[i];
    url = await pipeline.linkRedirect(rawUrl, null, res);
    if (!url) continue;
    type = await pipeline.detectResourceType(url, ResourceType.Binary, null, res);
    if (!type) continue;
    r = await pipeline.createResource(type, depth, url,
      res.url, res.localRoot, options.encoding[type]);
    if (!r) continue;
    r = await pipeline.processBeforeDownload(r, null, res, options);
    if (!r) continue;
    if (!r.shouldBeDiscardedFromDownload) {
      resources.push(r);
    }
    cssText = cssText.split(rawUrl).join(r.replacePath);
  }
  return cssText;
}

export const processCss: ProcessResourceAfterDownloadFunc = async (
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> => {
  if (res.type !== ResourceType.Css) {
    return res;
  }
  const depth: number = res.depth + 1;
  const resources: Resource[] = [];
  let cssText: string = toString(res.body, res.encoding ||
    options.encoding[ResourceType.Css]);
  cssText = await processCssText(cssText, res, options, pipeline, depth, resources);
  res.body = cssText;
  res.meta.cssProcessed = 1;
  await submit(resources);
  return res;
};
