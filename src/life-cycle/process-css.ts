import type {DownloadResource, SubmitResourceFunc} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import {toString} from '../util.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {parseCssUrlMatches} from './parse-css-urls.js';

export async function processCssText(
  cssText: string,
  res: DownloadResource,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor,
  depth: number,
  resources: Resource[]): Promise<string> {
  const cssUrls = parseCssUrlMatches(cssText);
  if (!cssUrls.length) return cssText;
  // Phase 1: process URLs and collect replacements
  const replacements = new Map<string, string>();
  const processed = new Map<string, Resource | void>();
  let rawUrl: string, r: Resource | void;
  // noinspection DuplicatedCode
  for (let i = 0, l = cssUrls.length; i < l; i++) {
    rawUrl = cssUrls[i].url;
    if (processed.has(rawUrl)) {
      continue;
    }
    r = await pipeline.createAndProcessResource(
      rawUrl, ResourceType.Binary, depth, null, res);
    processed.set(rawUrl, r);
    if (!r) continue;
    if (!r.shouldBeDiscardedFromDownload) {
      resources.push(r);
    }
    if (rawUrl !== r.replacePath) {
      replacements.set(rawUrl, r.replacePath);
    }
  }
  if (!replacements.size) return cssText;
  const parts: string[] = [];
  let lastEnd = 0;
  for (const {url, start, end} of cssUrls) {
    const replacePath = replacements.get(url);
    if (!replacePath) {
      continue;
    }
    parts.push(cssText.slice(lastEnd, start));
    parts.push(replacePath);
    lastEnd = end;
  }
  parts.push(cssText.slice(lastEnd));
  return parts.join('');
}

export async function processCss(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> {
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
  submit(resources);
  return res;
}
