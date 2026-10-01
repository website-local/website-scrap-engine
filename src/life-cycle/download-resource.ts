import type {BeforeRetryHook, OptionsInit, RequestError, Response} from 'got';
import got, {HTTPError, TimeoutError} from 'got';
import type {DownloadResource, RequestOptions} from './types.js';
import type {Resource} from '../resource.js';
import {generateSavePath, ResourceType} from '../resource.js';
import type {StaticDownloadOptions} from '../options.js';
import * as logger from '../logger/logger.js';
import {isUrlHttp} from '../util.js';
import URI from 'urijs';
import {ResourceSizeError} from '../resource-limits.js';

/** Take logs before retry */
export const beforeRetryHook: BeforeRetryHook = (
  error: RequestError,
  retryCount: number | undefined
) => {
  const options = error.options;
  if (!options) {
    return;
  }
  if (!error) {
    logger.retry.warn(retryCount, String(options.url));
    return;
  }
  const url = String(error.options.url);
  if (error instanceof TimeoutError || error.name === 'TimeoutError') {
    (retryCount && retryCount > 1 ? logger.retry.warn : logger.retry.info)
      .call(logger.retry, retryCount, url, error.name, error.code,
        error.message, (error as TimeoutError).event);
  } else {
    (retryCount && retryCount > 1 ? logger.retry.warn : logger.retry.info)
      .call(logger.retry, retryCount, url, error.name, error.code, error.message);
  }
};

export interface DownloadError extends Partial<Error> {
  retryLimitExceeded?: boolean;
  code?: string;
  event?: string;
}

export async function getRetry(
  url: string,
  options: OptionsInit,
  maxResourceBytes?: number
): Promise<Response<Buffer | string> | void> {
  // Got owns retry limits and hooks; successful empty bodies are valid responses.
  const limitController = maxResourceBytes === undefined ? undefined : new AbortController();
  const request = got(url, {...options, signal: limitController ?
    options.signal ? AbortSignal.any([options.signal, limitController.signal]) : limitController.signal :
    options.signal});
  let sizeError: ResourceSizeError | undefined;
  if (maxResourceBytes !== undefined) {
    request.on('downloadProgress', ({transferred}) => {
      if (transferred > maxResourceBytes) {
        sizeError = new ResourceSizeError(maxResourceBytes, transferred);
        limitController!.abort(sizeError);
      }
    });
  }
  try {
    const response = await request;
    // Got 16 returns Uint8Array for responseType: 'buffer'. Preserve our Buffer
    // contract and Buffer-based HTML checks without copying the response bytes.
    const body: unknown = response.body;
    if (body instanceof Uint8Array && !Buffer.isBuffer(body)) {
      (response as Response<Buffer | string>).body =
        Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    }
    return response as Response<Buffer | string>;
  } catch (error) {
    throw sizeError ?? error;
  }
}

export async function requestForResource(
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions,
  options?: StaticDownloadOptions
): Promise<DownloadResource | Resource | void> {
  let downloadLink: string;
  try {
    downloadLink = encodeURI(decodeURI(res.downloadLink));
  } catch {
    downloadLink = res.downloadLink;
  }
  const reqOptions: OptionsInit = Object.assign({}, requestOptions);
  reqOptions.responseType = 'buffer';
  if (res.refUrl && res.refUrl !== downloadLink) {
    const headers = Object.assign({}, reqOptions.headers);
    headers.referer = res.refUrl;
    reqOptions.headers = headers;
  }
  logger.request.info(res.url, downloadLink, res.refUrl,
    res.encoding, res.type);
  let response: Response<string | Buffer> | void;
  try {
    response = await getRetry(downloadLink, reqOptions, options?.maxResourceBytes);
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
}

export async function downloadResource(
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions
): Promise<DownloadResource | Resource | void> {
  if (res.body) {
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
  let downloadedResource: DownloadResource | Resource | void = await requestForResource(
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
        Buffer.isBuffer(downloadedResource.body)) &&
      downloadedResource.body.length > 0) {
      if (!downloadedResource.body.includes(options.meta.detectIncompleteHtml)) {
        logger.error.info('Detected incomplete html, try again',
          downloadedResource.downloadLink);
        downloadedResource = await requestForResource(
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
}
