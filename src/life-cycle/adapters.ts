import type {Logger} from '../logger/types.js';
import {load} from '../cheerio.js';
import type {Resource, ResourceEncoding} from '../resource.js';
import {ResourceType} from '../resource.js';
import type {
  AsyncResult,
  DownloadResource,
  ExistingResourceFunc,
  GenerateSavePathFunc,
  LinkRedirectFunc,
  ProcessResourceAfterDownloadFunc,
  ProcessResourceBeforeDownloadFunc,
  SubmitResourceFunc
} from './types.js';
import {toString} from '../util.js';
import type {StaticDownloadOptions} from '../options.js';
import type {HtmlParserOptions} from '../cheerio.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import type {Cheerio, CheerioStatic} from '../types.js';
import type URI from '../uri.js';

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
  (url: string, element: Cheerio | null, parent: Resource | null, pipeline: PipelineExecutor): boolean;
}

export const skipProcess = (fn: SkipProcessFunc): LinkRedirectFunc =>
  (url, element, parent, _options, pipeline) => fn(url, element, parent, pipeline) ? undefined : url;

export interface DropResourceFunc {
  (res: Resource, pipeline: PipelineExecutor): boolean;
}

export const dropResource = (fn: DropResourceFunc): ProcessResourceBeforeDownloadFunc =>
  (res, _element, _parent, _options, pipeline) => {
    if (fn(res, pipeline)) {
      res.shouldBeDiscardedFromDownload = true;
    }
    return res;
  };


export interface PreProcessResourceFunc {
  (url: string, element: Cheerio | null, res: Resource, parent: Resource | null, pipeline: PipelineExecutor): void;
}

export const preProcess = (fn: PreProcessResourceFunc): ProcessResourceBeforeDownloadFunc =>
  (res, element, parent, _options, pipeline) => {
    fn(res.url, element, res, parent, pipeline);
    return res;
  };

export interface RequestRedirectFunc {
  (url: string, res: Resource, pipeline: PipelineExecutor): string | void;
}

export const requestRedirect = (fn: RequestRedirectFunc): ProcessResourceBeforeDownloadFunc =>
  (res, _element, _parent, _options, pipeline) => {
    if (res.downloadLink) {
      const downloadLink: string | void = fn(res.downloadLink, res, pipeline) || undefined;
      if (!downloadLink) {
        return;
      }
      res.downloadLink = downloadLink;
    }
    return res;
  };

export const redirectFilter = (fn: RequestRedirectFunc): ProcessResourceAfterDownloadFunc =>
  (res, _submit, _options, pipeline) => {
    if (res.redirectedUrl) {
      res.redirectedUrl = fn(res.redirectedUrl, res, pipeline) || undefined;
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
  ($: CheerioStatic, res: Resource & { type: ResourceType.Html }, pipeline: PipelineExecutor): CheerioStatic;
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
  (res: DownloadResource, submit: SubmitResourceFunc, options: StaticDownloadOptions & HtmlParserOptions,
    pipeline: PipelineExecutor) => {
    if (res.type === ResourceType.Html) {
      const previous = res.meta.doc ?? parseHtml(res, options);
      res.meta.doc = fn(previous, res, pipeline);
      if (previous !== res.meta.doc) (previous as CheerioStatic & {dispose?: () => void}).dispose?.();
    }
    return res;
  };


export interface AsyncHtmlProcessFunc {
  ($: CheerioStatic, res: Resource & { type: ResourceType.Html }, pipeline: PipelineExecutor): AsyncResult<CheerioStatic>;
}

export const processHtmlAsync = (fn: AsyncHtmlProcessFunc): ProcessResourceAfterDownloadFunc =>
  async (res: DownloadResource, submit: SubmitResourceFunc, options: StaticDownloadOptions & HtmlParserOptions,
    pipeline: PipelineExecutor) => {
    if (res.type === ResourceType.Html) {
      const previous = res.meta.doc ?? parseHtml(res, options);
      res.meta.doc = await fn(previous, res, pipeline);
      if (previous !== res.meta.doc) (previous as CheerioStatic & {dispose?: () => void}).dispose?.();
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

/**
 * Wrap a legacy full save-path generator as a generateSavePath hook.
 *
 * @deprecated Prefer GenerateSavePathFunc hooks that transform the incoming
 * savePath.
 */
export function wrapLegacyGenerateSavePath(
  legacyFn: (uri: URI, isHtml?: boolean, keepSearch?: boolean,
    localSrcRoot?: string, logger?: Logger) => string
): GenerateSavePathFunc {
  const hook: GenerateSavePathFunc = (_savePath, ctx) => legacyFn(
    ctx.uri,
    ctx.type === ResourceType.Html,
    !ctx.options.deduplicateStripSearch,
    ctx.options.localSrcRoot,
    ctx.pipeline.logger
  );
  hook.fullSavePath = true;
  return hook;
}
