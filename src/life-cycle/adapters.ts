import {Resource, ResourceType} from '../resource';
import {
  DownloadResource,
  LinkRedirectFunc,
  ProcessResourceAfterDownloadFunc,
  ProcessResourceBeforeDownloadFunc, SubmitResourceFunc
} from '../pipeline';
import cheerio from 'cheerio';
import {toString} from '../util';
import {StaticDownloadOptions} from '../options';

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


export interface HtmlProcessFunc {
  ($: CheerioStatic, res: Resource & { type: ResourceType.Html }): CheerioStatic;
}

export const processHtml = (fn: HtmlProcessFunc): ProcessResourceAfterDownloadFunc =>
  (res: DownloadResource, submit: SubmitResourceFunc, options: StaticDownloadOptions) => {
    if (res.type === ResourceType.Html) {
      if (!res.meta.doc) {
        res.meta.doc = cheerio.load(toString(res.body,
          res.encoding || options.encoding[res.type] || 'utf8'));
      }
      res.meta.doc = fn(res.meta.doc, res);
    }
    return res;
  };


