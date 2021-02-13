import got, {HTTPError, RequestError} from 'got';
import type {Response} from 'got/dist/source/core';
import path from 'path';
import {constants, createWriteStream, promises as fs, WriteStream} from 'fs';
import {Resource, ResourceType} from '../resource';
import type {
  AsyncResult,
  DownloadResource,
  DownloadResourceFunc,
  RequestOptions
} from './types';
import {mkdirRetry} from '../io';
import {pipeline} from 'stream';
import {promisify} from 'util';
import {error as errorLogger, retry as retryLogger} from '../logger/logger';
import type {StaticDownloadOptions} from '../options';
import type {PipelineExecutor} from './pipeline-executor';
import {isUrlHttp} from '../util';

const promisifyPipeline = promisify(pipeline);

export function isBytesAccepted(acceptRange?: string): boolean {
  if (!acceptRange) {
    return false;
  }
  const ranges = acceptRange.split(',');
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i] === 'bytes') {
      return true;
    }
  }
  return false;
}

export function isSameRangeStart(rangeStart: number, contentRange?: string): boolean {
  if (!contentRange) {
    return false;
  }
  let ranges = contentRange.split(',');
  ranges = ranges[0].split(' ');
  if (ranges.length < 2 || !ranges[1]) {
    return false;
  }
  ranges = ranges[1].split('-');
  return +ranges[0] === rangeStart;
}

export async function streamingDownloadToFile(
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions
): Promise<Response | void> {
  const savePath = path.join(res.localRoot, decodeURI(res.savePath));
  try {
    await fs.access(savePath, constants.W_OK);
  } catch (e) {
    if (e?.code === 'ENOENT') {
      await mkdirRetry(path.dirname(savePath));
    } else {
      throw e;
    }
  }
  // force cast for typescript
  const options = Object.assign({}, requestOptions, {
    isStream: true
  }) as RequestOptions & {
    isStream?: true
  };
  let fileWriteStream: WriteStream | void;

  return new Promise<Response>((resolve, reject) => {
    let rangeIsSupported: void | boolean;
    let rangeStart: void | number;
    const makeRequest = (retryCount: number): void => {
      let isRetry = false;
      if (!rangeIsSupported && options.headers) {
        rangeStart = undefined;
        delete options.headers.range;
      } else if (rangeStart && rangeIsSupported) {
        if (!options.headers) {
          options.headers = {};
        }
        options.headers.range = `bytes=${rangeStart}-`;
        fileWriteStream = createWriteStream(savePath, {
          flags: 'a',
          start: rangeStart
        });
      }
      const request = got.stream(res.downloadLink, options);
      request.retryCount = retryCount;

      request.once('response', async (response: Response) => {
        response.retryCount = retryCount;
        res.meta.headers = response.headers;
        if (rangeIsSupported === undefined) {
          if (isBytesAccepted(response.headers['accept-ranges'])) {
            rangeIsSupported = true;
          }
        }
        if (rangeIsSupported && fileWriteStream && rangeStart &&
          (response.statusCode !== 206 ||
            !isSameRangeStart(rangeStart, response.headers['content-range']))) {
          errorLogger.warn('Unexpected response for range',
            rangeStart, response.headers['content-range'], response.statusCode);
          rangeIsSupported = false;
          fileWriteStream.destroy();
          fileWriteStream = undefined;
          rangeStart = undefined;
        }

        if (response.request.aborted) {
          // Canceled while downloading
          //- will throw a `CancelError` or `TimeoutError` error
          return;
        }
        // Download body
        if (!fileWriteStream) {
          fileWriteStream = createWriteStream(savePath, {
            flags: 'w'
          });
        }

        try {
          // Download body directly to file
          await promisifyPipeline(request, fileWriteStream);
        } catch {
          // The same error is caught below.
          // See request.once('error')
          return;
        }

        if (request._isAboutToError) {
          return;
        }

        resolve(response);
      });

      const destroyStream = () => {
        if (fileWriteStream) {
          if (rangeIsSupported) {
            if (rangeStart) {
              rangeStart += fileWriteStream.bytesWritten;
            } else {
              rangeStart = fileWriteStream.bytesWritten;
            }
          } else {
            rangeStart = undefined;
          }
          fileWriteStream.destroy();
        } else {
          rangeStart = undefined;
        }
        fileWriteStream = undefined;
      };

      const onError = (error: RequestError) => {
        // https://developer.mozilla.org/docs/Web/HTTP/Headers/Range
        // https://developer.mozilla.org/docs/Web/HTTP/Status/416
        if (error instanceof HTTPError && error.response.statusCode === 416) {
          errorLogger.warn('Unexpected response for range',
            rangeStart, error.response.headers['content-range'],
            error.response.statusCode);
          rangeIsSupported = false;
        }
        destroyStream();

        const {options} = request;

        if (error instanceof HTTPError && !options.throwHttpErrors) {
          const {response} = error;
          resolve(response);
          return;
        }
        if (!isRetry) {
          let retry = -1;
          if (error && error.message === 'premature close') {
            retryLogger.warn(retryCount, res.downloadLink,
              'manually retry on premature close',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              error.name, error.code, (error as any).event, error.message);
            retry = retryCount * 200;
          }
          // these events might be accidentally unhandled
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (error && !(error as any).retryLimitExceeded &&
            (error.name === 'RequestError' || error.name === 'TimeoutError') &&
            // RequestError: Cannot read property 'request' of undefined
            // at Object.exports.default (got\dist\source\core\utils\timed-out.js:56:23)
            // error.code === undefined
            (error.code === 'ETIMEDOUT' || error.code === undefined)) {
            retryLogger.warn(retryCount, res.downloadLink,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              `manually retry on ${(error as any).event} timeout`,
              error.name, error.code, error.message);
            retry = retryCount * 300;
          }
          if (retry > 0) {
            makeRequest(retryCount + 1);
            return;
          }
        }

        reject(error);
      };

      request.once('error', onError);

      request.once('retry', (newRetryCount: number) => {
        destroyStream();
        isRetry = true;
        makeRequest(newRetryCount);
      });

    };

    makeRequest(0);
  });
}

export async function optionallySetLastModifiedTime(
  res: Resource, options: StaticDownloadOptions
): Promise<void> {
  // https://github.com/website-local/website-scrap-engine/issues/174
  let mtime: number | void;
  if (options.preferRemoteLastModifiedTime && res.meta?.headers?.['last-modified']) {
    mtime = Date.parse(res.meta.headers?.['last-modified']);
  }

  // void and NaN check
  if (mtime) {
    const savePath = path.join(res.localRoot, decodeURI(res.savePath));
    try {
      await fs.utimes(savePath, mtime, mtime);
    } catch (e) {
      errorLogger.warn('skipping utimes ' + savePath, e);
    }
  }
}

export async function downloadStreamingResource(
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions
): Promise<Resource | DownloadResource | void> {
  if (res.body) {
    return res as DownloadResource;
  }
  if (res.type !== ResourceType.StreamingBinary) {
    return res;
  }
  if (!res.downloadStartTimestamp) {
    res.downloadStartTimestamp = Date.now();
    res.waitTime = res.downloadStartTimestamp - res.createTimestamp;
  }
  await streamingDownloadToFile(
    res as (Resource & { downloadStartTimestamp: number }), requestOptions);

  await optionallySetLastModifiedTime(res, options);
  /// Not needed before
  // res.finishTimestamp = Date.now();
  // res.downloadTime =
  //   res.finishTimestamp - res.downloadStartTimestamp;
  return;
}

export interface StreamingBeforeDownloadHook {
  /**
   * @see PipelineExecutor.download
   * @see downloadStreamingResource
   * @see downloadStreamingResourceWithHook
   * @param res target resource
   * @param requestOptions passed to got
   * @param options
   * @param pipeline
   * @return processed resource, or void to discard resource
   */
  (res: Resource, requestOptions: RequestOptions, options: StaticDownloadOptions,
   pipeline: PipelineExecutor): AsyncResult<DownloadResource | Resource | void>;
}

export interface StreamingAfterDownloadHook {
  /**
   * @see PipelineExecutor.download
   * @see downloadStreamingResource
   * @see downloadStreamingResourceWithHook
   * @param res target resource
   * @param requestOptions passed to got
   * @param options
   * @param pipeline
   */
  (res: Resource, requestOptions: RequestOptions, options: StaticDownloadOptions,
   pipeline: PipelineExecutor): AsyncResult<void>;
}

export interface StreamingDownloadErrorHook {
  /**
   * @see PipelineExecutor.download
   * @see downloadStreamingResource
   * @see downloadStreamingResourceWithHook
   * @param e error
   * @param res target resource
   * @param requestOptions passed to got
   * @param options
   * @param pipeline
   */
  (e: Error, res: Resource, requestOptions: RequestOptions,
   options: StaticDownloadOptions,
   pipeline: PipelineExecutor): AsyncResult<void>;
}

export function downloadStreamingResourceWithHook(
  beforeDownload?: StreamingBeforeDownloadHook,
  afterDownload?: StreamingAfterDownloadHook,
  downloadError?: StreamingDownloadErrorHook
): DownloadResourceFunc {
  if (!beforeDownload && !afterDownload && !downloadError) {
    return downloadStreamingResource;
  }
  return async (
    res: Resource,
    requestOptions: RequestOptions,
    options: StaticDownloadOptions,
    pipeline: PipelineExecutor
  ) => {
    if (res.body) {
      return res as DownloadResource;
    }
    if (res.type !== ResourceType.StreamingBinary) {
      return res;
    }
    if (!isUrlHttp(res.downloadLink)) {
      return res;
    }
    let resource: DownloadResource | Resource | void = res;
    if (beforeDownload) {
      resource = await beforeDownload(res, requestOptions, options, pipeline);
      if (!resource) {
        return;
      }
      if (resource.body) {
        return resource as DownloadResource;
      }
      if (resource.shouldBeDiscardedFromDownload) {
        return;
      }
    }
    if (!res.downloadStartTimestamp) {
      res.downloadStartTimestamp = Date.now();
      res.waitTime = res.downloadStartTimestamp - res.createTimestamp;
    }
    if (!downloadError) {
      await streamingDownloadToFile(
        res as (Resource & { downloadStartTimestamp: number }), requestOptions);
      await optionallySetLastModifiedTime(res, options);
    } else {
      try {
        await streamingDownloadToFile(
          res as (Resource & { downloadStartTimestamp: number }), requestOptions);
        await optionallySetLastModifiedTime(res, options);
      } catch (e) {
        await downloadError(e, res, requestOptions, options, pipeline);
      }
    }
    res.finishTimestamp = Date.now();
    res.downloadTime =
      res.finishTimestamp - res.downloadStartTimestamp;
    if (afterDownload) {
      await afterDownload(res, requestOptions, options, pipeline);
    }
    return;
  };
}
