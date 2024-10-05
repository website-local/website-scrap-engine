import got, {
  BeforeRetryHook,
  NormalizedOptions,
  Options,
  RequestError,
  TimeoutError
} from 'got';
import type {Response} from 'got/dist/source/as-promise';
import type {DownloadResource, RequestOptions} from './types';
import {generateSavePath, Resource, ResourceType} from '../resource';
import type {StaticDownloadOptions} from '../options';
import * as logger from '../logger/logger';
import {isUrlHttp, sleep} from '../util';
import URI from 'urijs';

/** Take logs before retry */
export const beforeRetryHook: BeforeRetryHook = (
  options: NormalizedOptions,
  error: RequestError | undefined,
  retryCount: number | undefined
) => {
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

/**
 * workaround for retry premature close on node 12
 * retry on empty body
 *
 * @param url
 * @param options
 */
export async function getRetry(
  url: string,
  options: Options
): Promise<Response<Buffer | string> | void> {
  let res: Response<Buffer | string> | void = void 0;
  let err: DownloadError | void = void 0, optionsClone: Options;
  for (let i = 0; i < 25; i++) {
    err = void 0;
    try {
      optionsClone = Object.assign({}, options);
      res = (await got(url, optionsClone)) as Response<Buffer | string>;
      if (!res || !res.body || !res.body.length) {
        logger.retry.warn(i, url, 'manually retry on empty response or body',
          res && res.body);
        continue;
      }
      break;
    } catch (e) {
      // force cast for typescript 4.4
      err = e as DownloadError | void;
      if (err && err.message === 'premature close') {
        logger.retry.warn(i, url, 'manually retry on premature close',
          err.name, err.code, err.event, err.message);
        await sleep(i * 200);
        continue;
      }
      // these events might be accidentally unhandled
      if (err && !err.retryLimitExceeded &&
        (err.name === 'RequestError' || err.name === 'TimeoutError') &&
        // RequestError: Cannot read property 'request' of undefined
        // at Object.exports.default (got\dist\source\core\utils\timed-out.js:56:23)
        // error.code === undefined
        (err.code === 'ETIMEDOUT' || err.code === undefined)) {
        logger.retry.warn(i, url, `manually retry on ${err.event} timeout`,
          err.name, err.code, err.message);
        await sleep(i * 300);
        continue;
      }
      throw e;
    }
  }
  if (err) {
    logger.error.error(url, 'no more retries on premature close or timeout',
      err.message, err.name, err);
    throw err;
  }
  return res;
}

export async function requestForResource(
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions,
  options?: StaticDownloadOptions
): Promise<DownloadResource | Resource | void> {
  const downloadLink: string = encodeURI(decodeURI(res.downloadLink));
  const reqOptions: Options = Object.assign({}, requestOptions);
  reqOptions.responseType = 'buffer';
  if (res.refUrl && res.refUrl !== downloadLink) {
    const headers = Object.assign({}, reqOptions.headers);
    headers.referer = res.refUrl;
    reqOptions.headers = headers;
  }
  logger.request.info(res.url, downloadLink, res.refUrl,
    res.encoding, res.type);
  const response: Response<string | Buffer> | void =
    await getRetry(downloadLink, reqOptions);
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
    if (options.meta.detectIncompleteHtml &&
      (typeof downloadedResource.body === 'string' ||
        Buffer.isBuffer(downloadedResource.body))) {
      if (!downloadedResource.body.includes(options.meta.detectIncompleteHtml)) {
        logger.error.info('Detected incomplete html, try again',
          downloadedResource.downloadLink);
        downloadedResource = await requestForResource(
          res as (Resource & { downloadStartTimestamp: number }), requestOptions);
      }
      // probably more retries here?
      if (!downloadedResource || typeof downloadedResource.body === 'string' &&
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
