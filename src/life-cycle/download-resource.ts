import {
  DownloadResource,
  DownloadResourceFunc,
  RequestOptions
} from '../pipeline';
import {Resource, ResourceType} from '../resource';
import {StaticDownloadOptions} from '../options';
import * as logger from '../logger/logger';
import {sleep} from '../util';
import got, {
  BeforeRetryHook,
  NormalizedOptions,
  Options,
  RequestError,
  TimeoutError
} from 'got';
import {Response} from 'got/dist/source/as-promise';

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


/**
 * workaround for retry premature close on node 12
 * retry on empty body
 *
 * @param url
 * @param options
 */
export const getRetry = async (
  url: string,
  options: Options
): Promise<Response<Buffer | string> | void> => {
  let res: Response<Buffer | string> | void;
  let err: Error | void, optionsClone: Options;
  for (let i = 0; i < 25; i++) {
    err = void 0;
    try {
      optionsClone = Object.assign({}, options);
      res = (await got(url, optionsClone)) as typeof res;
      if (!res || !res.body || !res.body.length) {
        logger.retry.warn(i, url, 'manually retry on empty response or body',
          res && res.body);
        continue;
      }
      break;
    } catch (e) {
      err = e;
      if (e && e.message === 'premature close') {
        logger.retry.warn(i, url, 'manually retry on premature close',
          e.name, e.code, e.event, e.message);
        await sleep(i * 200);
        continue;
      }
      // these events might be accidentally unhandled
      if (e && !e.retryLimitExceeded &&
        (e.name === 'RequestError' || e.name === 'TimeoutError') &&
        e.code === 'ETIMEDOUT') {
        logger.retry.warn(i, url, `manually retry on ${e.event} timeout`,
          e.name, e.code, e.message);
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
};

export const requestForResource = async (
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions
): Promise<DownloadResource | Resource | void> => {
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
    delete res.downloadStartTimestamp;
    delete res.waitTime;
    return res as Resource;
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
  res.body = response.body;
  return res;
};

export const downloadResource: DownloadResourceFunc = async (
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions
): Promise<DownloadResource | Resource | void> => {
  if (res.body) {
    return res as DownloadResource;
  }
  if (!res.downloadStartTimestamp) {
    res.downloadStartTimestamp = Date.now();
    res.waitTime = res.downloadStartTimestamp - res.createTimestamp;
  }
  let downloadedResource: DownloadResource | Resource | void = await requestForResource(
    res as (Resource & { downloadStartTimestamp: number }), requestOptions);
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
};
