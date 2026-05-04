import type {DownloadResource, SubmitResourceFunc} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import {toString} from '../util.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import parseCssUrls from './parse-css-urls.js';

export async function processCssText(
  cssText: string,
  res: DownloadResource,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor,
  depth: number,
  resources: Resource[]): Promise<string> {
  const cssUrls: string[] = parseCssUrls(cssText);
  if (!cssUrls.length) return cssText;
  // Phase 1: process URLs and collect replacements
  const replacements: Array<[string, string]> = [];
  let rawUrl: string, r: Resource | void;
  // noinspection DuplicatedCode
  for (let i = 0, l = cssUrls.length; i < l; i++) {
    rawUrl = cssUrls[i];
    r = await pipeline.createAndProcessResource(
      rawUrl, ResourceType.Binary, depth, null, res);
    if (!r) continue;
    if (!r.shouldBeDiscardedFromDownload) {
      resources.push(r);
    }
    if (rawUrl !== r.replacePath) {
      replacements.push([rawUrl, r.replacePath]);
    }
  }
  if (!replacements.length) return cssText;
  // Phase 2: single-pass positional replacement to avoid
  // corrupting already-replaced paths
  const occurrences: Array<[number, number, string]> = [];
  for (const [url, replacePath] of replacements) {
    let from = 0, pos: number;
    while ((pos = cssText.indexOf(url, from)) !== -1) {
      occurrences.push([pos, url.length, replacePath]);
      from = pos + url.length;
    }
  }
  if (!occurrences.length) return cssText;
  occurrences.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let lastEnd = 0;
  for (const [pos, len, replacePath] of occurrences) {
    if (pos < lastEnd) continue;
    parts.push(cssText.slice(lastEnd, pos));
    parts.push(replacePath);
    lastEnd = pos + len;
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
