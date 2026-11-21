import {disposeHtmlResource, load} from '../cheerio.js';
import type {HtmlParserOptions} from '../cheerio.js';
import type {Resource, ResourceEncoding} from '../resource.js';
import {ResourceType} from '../resource.js';
import type {
  AsyncResult,
  DownloadResource,
  ExistingResourceFunc,
  LinkRedirectFunc,
  ProcessResourceAfterDownloadFunc,
  ProcessResourceBeforeDownloadFunc,
  SubmitResourceFunc
} from './types.js';
import {toString} from '../util.js';
import type {StaticDownloadOptions} from '../options.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import type {Cheerio, CheerioStatic} from '../types.js';

export {
  LocalUrlMountFileSizeError,
  LocalUrlMountNotFoundError,
  localUrlMounts
} from './local-url-mount.js';
export type {
  LocalUrlMount,
  LocalUrlMountCacheOptions,
  LocalUrlMountCaseMode,
  LocalUrlMountContentTypeOptions,
  LocalUrlMountIndexOptions,
  LocalUrlMountLimits,
  LocalUrlMountMeta,
  LocalUrlMountNotFound,
  LocalUrlMountOptions,
  LocalUrlMountSearchMode
} from './local-url-mount.js';

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

export function processRedirectedUrl(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor
): AsyncResult<DownloadResource | void> {
  if (res.redirectedUrl && res.redirectedUrl !== res.url) {
    return processRedirectedResource(res, pipeline, res.redirectedUrl);
  }
  return res;
}

async function processRedirectedResource(
  res: DownloadResource,
  pipeline: PipelineExecutor,
  redirectedUrl: string
): Promise<DownloadResource | void> {
  const redirectedRes: Resource | void = await pipeline.createAndProcessResource(
    redirectedUrl, res.type, res.depth, null, res);
  if (redirectedRes) {
    res.redirectedUrl = redirectedRes.url;
    // https://github.com/website-local/website-scrap-engine/issues/385
    // 2011/11/15
    if (redirectedRes.savePath) {
      res.redirectedSavePath = redirectedRes.savePath;
    }
    // This resource only supplies redirect metadata; it is never submitted.
    if (redirectedRes !== res && redirectedRes.meta.doc && redirectedRes.meta.doc !== res.meta.doc) {
      const disposing = disposeHtmlResource(redirectedRes);
      if (disposing) await disposing;
    }
  }
  return res;
}

export interface HtmlProcessFunc {
  ($: CheerioStatic, res: Resource & { type: ResourceType.Html }): CheerioStatic;
}

export const parseHtml = (
  res: DownloadResource,
  options: StaticDownloadOptions & HtmlParserOptions
): CheerioStatic => {
  const encoding: ResourceEncoding =
    res.encoding || options.encoding[res.type as ResourceType] || 'utf8';
  return res.meta.doc = load(toString(res.body, encoding), options.cheerioParse, undefined, options);
};

export const processHtml = (fn: HtmlProcessFunc): ProcessResourceAfterDownloadFunc =>
  (res: DownloadResource, submit: SubmitResourceFunc, options: StaticDownloadOptions & HtmlParserOptions) => {
    if (res.type === ResourceType.Html) {
      const previous = res.meta.doc ?? parseHtml(res, options);
      res.meta.doc = fn(previous, res);
      if (previous !== res.meta.doc) {
        const disposing = disposeHtmlResource({meta: {doc: previous, statusChanges: res.meta.statusChanges}});
        if (disposing) return disposing.then(() => res);
      }
    }
    return res;
  };


export interface AsyncHtmlProcessFunc {
  ($: CheerioStatic, res: Resource & { type: ResourceType.Html }): AsyncResult<CheerioStatic>;
}

export const processHtmlAsync = (fn: AsyncHtmlProcessFunc): ProcessResourceAfterDownloadFunc =>
  async (res: DownloadResource, submit: SubmitResourceFunc, options: StaticDownloadOptions & HtmlParserOptions) => {
    if (res.type === ResourceType.Html) {
      const previous = res.meta.doc ?? parseHtml(res, options);
      res.meta.doc = await fn(previous, res);
      if (previous !== res.meta.doc) {
        const disposing = disposeHtmlResource({meta: {doc: previous, statusChanges: res.meta.statusChanges}});
        if (disposing) await disposing;
      }
    }
    return res;
  };

/** Skip download if local file already exists */
export const skipExisting = (): ExistingResourceFunc =>
  ({stage}) => stage === 'download' ? 'skip' : 'overwrite';

/** Re-download only if remote is newer (If-Modified-Since) */
export const preferNewerRemote = (): ExistingResourceFunc =>
  () => 'ifModifiedSince';

/** Always overwrite (current default behavior, explicit) */
export const alwaysOverwrite = (): ExistingResourceFunc =>
  () => 'overwrite';
