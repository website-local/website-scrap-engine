import got, {HTTPError, RequestError} from 'got';
import {Response} from 'got/dist/source/core';
import {Resource, ResourceType} from '../resource';
import {
  AsyncResult,
  DownloadResource,
  DownloadResourceFunc,
  RequestOptions
} from './types';
import path from 'path';
import {constants, createWriteStream, promises as fs, WriteStream} from 'fs';
import {mkdirRetry} from '../io';
import {pipeline} from 'stream';
import {promisify} from 'util';
import {retry as retryLogger} from '../logger/logger';
import {StaticDownloadOptions} from '../options';
import {PipelineExecutor} from './pipeline-executor';

const promisifyPipeline = promisify(pipeline);

export async function streamingDownloadToFile(
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions
): Promise<Response | void> {
  try {
    await fs.access(res.savePath, constants.W_OK);
  } catch (e) {
    if (e?.code === 'ENOENT') {
      await mkdirRetry(path.dirname(res.savePath));
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
  let fos: WriteStream | void;

  return new Promise<Response>((resolve, reject) => {
    const makeRequest = (retryCount: number): void => {
      let isRetry = false;
      const request = got.stream(res.downloadLink, options);
      request.retryCount = retryCount;

      request.once('response', async (response: Response) => {
        response.retryCount = retryCount;
        res.meta.headers = response.headers;

        if (response.request.aborted) {
          // Canceled while downloading - will throw a `CancelError` or `TimeoutError` error
          return;
        }
        // Download body
        if (!fos) {
          fos = createWriteStream(res.savePath, {
            flags: 'w'
          });
        }

        try {
          // Download body directly to file
          await promisifyPipeline(request, fos);
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

      const onError = (error: RequestError) => {
        if (fos) {
          fos.destroy();
        }
        fos = undefined;

        const {options} = request;

        if (error instanceof HTTPError && !options.throwHttpErrors) {
          const {response} = error;
          resolve(response);
          return;
        }
        if (!isRetry) {
          let retry = -1;
          if (error && error.message === 'premature close') {
            retryLogger.warn(retryCount, res.downloadLink, 'manually retry on premature close',
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
        if (fos) {
          fos.destroy();
        }
        fos = undefined;
        isRetry = true;
        makeRequest(newRetryCount);
      });

    };

    makeRequest(0);
  });
}

export async function downloadStreamingResource(
  res: Resource,
  requestOptions: RequestOptions
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

  /// Not needed
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
    } else {
      try {
        await streamingDownloadToFile(
          res as (Resource & { downloadStartTimestamp: number }), requestOptions);
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
