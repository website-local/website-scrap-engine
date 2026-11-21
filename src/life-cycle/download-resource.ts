import type {OptionsInit, Response} from 'got';
import got, {HTTPError} from 'got';
import type {DownloadResource, RequestOptions} from './types.js';
import type {Resource} from '../resource.js';
import {generateSavePath, ResourceType} from '../resource.js';
import type {StaticDownloadOptions} from '../options.js';
import * as logger from '../logger/logger.js';
import {isUrlHttp} from '../util.js';
import URI from '../uri.js';
import type {NativeHttpResponse} from './native-http.js';
import {withHttpCacheSafety} from './retry-hook.js';

export {beforeRetryHook} from './retry-hook.js';

export interface DownloadError extends Partial<Error> {
  retryLimitExceeded?: boolean;
  code?: string;
  event?: string;
}

export function getRetry(
  url: string,
  options: OptionsInit
): Promise<Response<Buffer | string> | void> {
  return getResponse(url, withHttpCacheSafety(options));
}

async function getResponse(
  url: string,
  options: OptionsInit
): Promise<Response<Buffer | string> | void> {
  // Got owns retry limits and hooks. Successful empty bodies are valid.
  const response = await got(url, options as OptionsInit & {
    isStream?: false; resolveBodyOnly?: false
  }) as Response<unknown>;
  const body = response.body;
  // Got 16 returns Uint8Array. Keep the engine's Buffer contract without copying.
  // If Got changes body storage, recheck request-url/resource-encoding and
  // save-body-ownership tests; a view here shares the response's backing store.
  if (body instanceof Uint8Array && !Buffer.isBuffer(body)) {
    (response as Response<Buffer | string>).body = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  return response as Response<Buffer | string>;
}

type ResourceRequester = (
  url: string, options: RequestOptions, resource: Resource
) => Promise<Response<string | Buffer> | (NativeHttpResponse & {body: Buffer}) | void>;

function createResourceRequester(request: ResourceRequester) {
  return async (
    res: Resource & { downloadStartTimestamp: number },
    requestOptions: RequestOptions,
    options?: StaticDownloadOptions
  ): Promise<DownloadResource | Resource | void> => {
    // Keep escaped URL bytes intact, including reserved characters and signed
    // query values. The transport also handles caller-supplied Unicode URLs.
    const downloadLink = res.downloadLink;
    const reqOptions: OptionsInit = {...requestOptions, responseType: 'buffer'};
    if (res.refUrl && res.refUrl !== downloadLink) {
      reqOptions.headers = {...reqOptions.headers, referer: res.refUrl};
    }
    logger.request.info(res.url, downloadLink, res.refUrl,
      res.encoding, res.type);
    let response: Response<string | Buffer> | (NativeHttpResponse & {body: Buffer}) | void;
    try {
      response = await request(downloadLink, reqOptions, res);
    } catch (e) {
      if (e instanceof HTTPError &&
        (e as HTTPError).response.statusCode === 304) {
        return undefined;
      }
      throw e;
    }
    if (response?.statusCode === 304) {
      return undefined;
    }
    if (!response) {
      const resource = res as Resource;
      delete resource.downloadStartTimestamp;
      delete resource.waitTime;
      return resource;
    }
    if (!response.body) {
      logger.error.warn('Empty response body:', downloadLink, response);
      return res as Resource;
    }
    res.meta.headers = response.headers;

    logger.response.info(response.statusCode, response.requestUrl, res.url,
      downloadLink, res.refUrl, res.encoding, res.type);
    res.finishTimestamp = Date.now();
    res.downloadTime = res.finishTimestamp - res.downloadStartTimestamp;
    res.redirectedUrl = response.url;
    // https://github.com/website-local/website-scrap-engine/issues/385
    // 2011/11/15
    if (res.redirectedUrl !== res.url) {
      res.redirectedSavePath = generateSavePath(
        URI(res.redirectedUrl),
        res.type === ResourceType.Html,
        !options?.deduplicateStripSearch,
        options?.localSrcRoot);
    }
    res.body = response.body;
    return res;
  };
}

const directGotRequestForResource = createResourceRequester(getResponse);
let guardedRequester: typeof directGotRequestForResource | undefined;
function gotRequestForResource(
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions,
  options?: StaticDownloadOptions
): Promise<DownloadResource | Resource | void> {
  guardedRequester ??= createResourceRequester(getRetry);
  return guardedRequester(res, requestOptions, options);
}
async function nativeRequest(url: string, options: RequestOptions, resource: Resource) {
  const {canUseNativeHttp, nativeBufferedRequest} = await import('./native-http.js');
  const native = canUseNativeHttp(options);
  resource.meta.httpTransport = native ? 'native' : 'got';
  return native ? nativeBufferedRequest(url, options) : getRetry(url, options);
}

let nativeRequester: typeof gotRequestForResource | undefined;
function nativeRequestForResource(
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions,
  options?: StaticDownloadOptions
): Promise<DownloadResource | Resource | void> {
  nativeRequester ??= createResourceRequester(nativeRequest);
  return nativeRequester(res, requestOptions, options);
}

/** Direct-call convenience API; initialized lifecycle hooks use a fixed requester. */
export function requestForResource(
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions,
  options?: StaticDownloadOptions
): Promise<DownloadResource | Resource | void> {
  return (options?.httpTransport === 'native' ? nativeRequestForResource : gotRequestForResource)(
    res, requestOptions, options);
}

function createResourceDownloader(request: typeof gotRequestForResource) {
  return async (
    res: Resource,
    requestOptions: RequestOptions,
    options: StaticDownloadOptions
  ): Promise<DownloadResource | Resource | void> => {
    if (res.body !== undefined) {
      return res as DownloadResource;
    }
    if (res.type === ResourceType.StreamingBinary) {
      return res;
    }
    if (!isUrlHttp(res.downloadLink)) {
      return res;
    }
    if (!res.downloadStartTimestamp) {
      res.downloadStartTimestamp = Date.now();
      res.waitTime = res.downloadStartTimestamp - res.createTimestamp;
    }
    let downloadedResource: DownloadResource | Resource | void = await request(
      res as (Resource & { downloadStartTimestamp: number }), requestOptions, options);
    if (!downloadedResource || !downloadedResource.body) {
      return downloadedResource;
    }
    if (downloadedResource.type === ResourceType.Html) {
      if (options.meta.warnForNonHtml) {
        const headers = downloadedResource.meta.headers;
        if (headers) {
          const contentType =
            headers['content-type'] || headers['Content-Type'];
          let nonHtml = false;
          if (typeof contentType === 'string') {
            nonHtml = !contentType.includes('/html') &&
              !contentType.includes('/xml') &&
              !contentType.includes('application/xhtml+xml');
          } else if (Array.isArray(contentType)) {
            nonHtml = true;
            for (const header of contentType) {
              if (header.includes('/html') ||
                header.includes('/xml') ||
                header.includes('application/xhtml+xml')) {
                nonHtml = false;
                break;
              }
            }
          }
          if (nonHtml) {
            logger.error.warn('Detected non-html content type for resource typed as',
              downloadedResource.type,
              downloadedResource.downloadLink, downloadedResource.rawUrl, contentType);
          }
        }
      }
      if (options.meta.detectIncompleteHtml &&
        (typeof downloadedResource.body === 'string' ||
          Buffer.isBuffer(downloadedResource.body)) && downloadedResource.body.length > 0) {
        if (!downloadedResource.body.includes(options.meta.detectIncompleteHtml)) {
          logger.error.info('Detected incomplete html, try again',
            downloadedResource.downloadLink);
          downloadedResource = await request(
            res as (Resource & { downloadStartTimestamp: number }), requestOptions, options);
        }
        // probably more retries here?
        if (!downloadedResource ||
          (typeof downloadedResource.body === 'string' ||
            Buffer.isBuffer(downloadedResource.body)) &&
          !downloadedResource.body.includes(options.meta.detectIncompleteHtml)) {
          logger.error.warn('Detected incomplete html twice', res.downloadLink);
          return downloadedResource;
        }
      }
      downloadedResource.finishTimestamp = Date.now();
      downloadedResource.downloadTime =
        downloadedResource.finishTimestamp - res.downloadStartTimestamp;
    }
    return downloadedResource;
  };
}

// These functions capture only a requester, never mutable request options or a
// client. Default resources perform no native selection or metadata bookkeeping.
/** Selected during initialization for the standard uncached lifecycle. */
export const downloadResourceDirect = createResourceDownloader(directGotRequestForResource);
let guardedDownloader: typeof downloadResourceDirect | undefined;
export function downloadResource(
  res: Resource, requestOptions: RequestOptions, options: StaticDownloadOptions
): Promise<DownloadResource | Resource | void> {
  guardedDownloader ??= createResourceDownloader(gotRequestForResource);
  return guardedDownloader(res, requestOptions, options);
}
let nativeDownloader: ReturnType<typeof createResourceDownloader> | undefined;
export function downloadNativeResource(
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions
): Promise<DownloadResource | Resource | void> {
  nativeDownloader ??= createResourceDownloader(nativeRequestForResource);
  return nativeDownloader(res, requestOptions, options);
}
