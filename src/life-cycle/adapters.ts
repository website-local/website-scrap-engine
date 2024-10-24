import {load} from 'cheerio';
import type {Resource, ResourceEncoding} from '../resource.js';
import {ResourceType} from '../resource.js';
import type {
  AsyncResult,
  DownloadResource,
  LinkRedirectFunc,
  ProcessResourceAfterDownloadFunc,
  ProcessResourceBeforeDownloadFunc,
  SubmitResourceFunc
} from './types.js';
import {toString} from '../util.js';
import type {StaticDownloadOptions} from '../options.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import type {Cheerio, CheerioStatic} from '../types.js';

export interface SkipProcessFunc {
  (url: string, element: Cheerio | null, parent: Resource | null): boolean;
}

export const skipProcess = (fn: SkipProcessFunc): LinkRedirectFunc =>
  (url, element, parent) => fn(url, element, parent) ? undefined : url;

export interface DropResourceFunc {
  (res: Resource): boolean;
}

export const dropResource = (fn: DropResourceFunc): ProcessResourceBeforeDownloadFunc =>
  res => {
    if (fn(res)) {
      res.shouldBeDiscardedFromDownload = true;
    }
    return res;
  };


export interface PreProcessResourceFunc {
  (url: string, element: Cheerio | null, res: Resource, parent: Resource | null): void;
}

export const preProcess = (fn: PreProcessResourceFunc): ProcessResourceBeforeDownloadFunc =>
  (res, element, parent) => {
    fn(res.url, element, res, parent);
    return res;
  };

export interface RequestRedirectFunc {
  (url: string, res: Resource): string | void;
}

export const requestRedirect = (fn: RequestRedirectFunc): ProcessResourceBeforeDownloadFunc =>
  res => {
    if (res.downloadLink) {
      const downloadLink: string | void = fn(res.downloadLink, res) || undefined;
      if (!downloadLink) {
        return;
      }
      res.downloadLink = downloadLink;
    }
    return res;
  };

export const redirectFilter = (fn: RequestRedirectFunc): ProcessResourceAfterDownloadFunc =>
  res => {
    if (res.redirectedUrl) {
      res.redirectedUrl = fn(res.redirectedUrl, res) || undefined;
    }
    return res;
  };

export async function processRedirectedUrl(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor
): Promise<DownloadResource | void> {
  if (res.redirectedUrl && res.redirectedUrl !== res.url) {
    const redirectedRes: Resource | void = await pipeline.createAndProcessResource(
      res.redirectedUrl, res.type, res.depth, null, res);
    if (redirectedRes) {
      res.redirectedUrl = redirectedRes.url;
      // https://github.com/website-local/website-scrap-engine/issues/385
      // 2011/11/15
      if (redirectedRes.savePath) {
        res.redirectedSavePath = redirectedRes.savePath;
      }
    }
  }
  return res;
}

export interface HtmlProcessFunc {
  ($: CheerioStatic, res: Resource & { type: ResourceType.Html }): CheerioStatic;
}

export const parseHtml = (
  res: DownloadResource & { type: ResourceType.Html },
  options: StaticDownloadOptions
): CheerioStatic => {
  const encoding: ResourceEncoding =
    res.encoding || options.encoding[res.type] || 'utf8';
  if (options.cheerioParse) {
    return load(toString(res.body, encoding), options.cheerioParse);
  }
  return load(toString(res.body, encoding));
};

export const processHtml = (fn: HtmlProcessFunc): ProcessResourceAfterDownloadFunc =>
  (res: DownloadResource, submit: SubmitResourceFunc, options: StaticDownloadOptions) => {
    if (res.type === ResourceType.Html) {
      if (!res.meta.doc) {
        res.meta.doc = parseHtml(res, options);
      }
      res.meta.doc = fn(res.meta.doc, res);
    }
    return res;
  };


export interface AsyncHtmlProcessFunc {
  ($: CheerioStatic, res: Resource & { type: ResourceType.Html }): AsyncResult<CheerioStatic>;
}

export const processHtmlAsync = (fn: AsyncHtmlProcessFunc): ProcessResourceAfterDownloadFunc =>
  async (res: DownloadResource, submit: SubmitResourceFunc, options: StaticDownloadOptions) => {
    if (res.type === ResourceType.Html) {
      if (!res.meta.doc) {
        res.meta.doc = parseHtml(res, options);
      }
      res.meta.doc = await fn(res.meta.doc, res);
    }
    return res;
  };

