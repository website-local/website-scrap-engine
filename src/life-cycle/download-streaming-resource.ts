import {markResourceDownloaded} from '../crawl-context.js';
import type {WriteStream} from 'node:fs';
import {constants, createWriteStream, promises as fs} from 'node:fs';
import {finished as streamFinished, pipeline} from 'node:stream/promises';
import type {Response} from 'got';
import got, {HTTPError, RequestError} from 'got';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import type {
  AsyncResult,
  DownloadResource,
  DownloadResourceFunc,
  RequestOptions
} from './types.js';
import {safeJoin} from '../io.js';
import {noFollowWriteFlags, publishFile} from '../output-store.js';
import {limitResourceStream} from '../resource-limits.js';
import {error as errorLogger} from '../logger/logger.js';
import type {StaticDownloadOptions} from '../options.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {isUrlHttp} from '../util.js';
import {canUseNativeHttp, withNativeHttp} from './native-http.js';
import type {NativeHttpResponse} from './native-http.js';
import {withHttpCacheSafety} from './http-cache-safety.js';

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

export function shouldWaitForRequestError(error: unknown): boolean {
  return error instanceof RequestError ||
    (error as {name?: string} | undefined)?.name === 'RequestError' ||
    (error as {name?: string} | undefined)?.name === 'TimeoutError';
}

export async function streamingDownloadToFile(
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions,
  executor?: PipelineExecutor,
  options?: StaticDownloadOptions
): Promise<Response | NativeHttpResponse | void> {
  const savePath = safeJoin(res.localRoot, decodeURI(res.savePath));
  let response: Response | NativeHttpResponse | void = undefined;
  let skipped = false;
  await publishFile(savePath, async (staging, direct) => {
    response = await streamToStagingFile(res, requestOptions, staging, options?.maxResourceBytes,
      direct && executor ? async () => {
        skipped = !await executor.shouldSaveResource(res);
        return !skipped;
      } : undefined, !!direct && noFollowWriteFlags !== undefined, options?.httpTransport === 'native');
    if (response && response.statusCode !== 304) {
      markResourceDownloaded();
      res.redirectedUrl = response.url;
    }
    if (!skipped && response?.statusCode !== 304 && options) {
      await optionallySetLastModifiedTime(res, options, staging);
    }
    if (skipped || response?.statusCode === 304) return false;
  }, requestOptions.signal, res.localRoot, async () => {
    // Direct streams check the response-aware save policy before opening output.
    if (!response) return true;
    if (response?.statusCode === 304) return false;
    return executor ? executor.shouldSaveResource(res) : true;
  }, noFollowWriteFlags !== undefined);
  return response;
}

async function streamToStagingFile(
  res: Resource & {downloadStartTimestamp: number},
  requestOptions: RequestOptions,
  savePath: string,
  maxResourceBytes?: number,
  beforeWrite?: () => Promise<boolean>,
  rejectSymlinks = false,
  preferNative = false
): Promise<Response | NativeHttpResponse> {
  if (preferNative && canUseNativeHttp(requestOptions)) {
    res.meta.httpTransport = 'native';
    return withNativeHttp(res.downloadLink, requestOptions, async (response, body) => {
      res.meta.headers = response.headers;
      if (response.statusCode === 304 || beforeWrite && !await beforeWrite()) {
        // Finish acquisition without opening or replacing cached output.
        body.resume();
        await streamFinished(body, {cleanup: true});
        return response;
      }
      const output = createWriteStream(savePath, {highWaterMark: 256 * 1024,
        flags: rejectSymlinks ? noFollowWriteFlags : 'w'} as Parameters<typeof createWriteStream>[1]);
      if (maxResourceBytes === undefined) await pipeline(body, output);
      else await pipeline(body, limitResourceStream(maxResourceBytes), output);
      return response;
    });
  }
  if (preferNative) res.meta.httpTransport = 'got';
  const options = withHttpCacheSafety(Object.assign({}, requestOptions, {
    isStream: true, headers: {...requestOptions.headers}
  }) as RequestOptions & {
    isStream?: true
  });
  let fileWriteStream: WriteStream | void;
  let activeRequest: ReturnType<typeof got.stream> | undefined;

  const activePumps = new Set<Promise<void>>();
  let finished = false;
  try {
    return await new Promise<Response>((resolve, reject) => {
      let rangeIsSupported: void | boolean;
      let rangeStart: void | number;
      const makeRequest = (retryCount: number): void => {
        if (finished) return;
        let isRetry = false;
        if (!rangeIsSupported && options.headers) {
          rangeStart = undefined;
          delete options.headers.range;
        } else if (rangeStart && rangeIsSupported) {
          if (!options.headers) {
            options.headers = {};
          }
          options.headers.range = `bytes=${rangeStart}-`;
        }
        const request = got.stream(res.downloadLink, options);
        activeRequest = request;
        request.retryCount = retryCount;

        request.once('response', async (response: Response) => {
          response.retryCount = retryCount;
          if (response.statusCode === 304) {
            // Drain the response without opening or modifying the cached file.
            request.once('end', () => resolve(response));
            request.resume();
            return;
          }
          res.meta.headers = response.headers;
          if (rangeIsSupported === undefined) {
            if (isBytesAccepted(response.headers['accept-ranges'])) {
              rangeIsSupported = true;
            }
          }
          if (rangeIsSupported && rangeStart &&
            (response.statusCode !== 206 ||
              !isSameRangeStart(rangeStart, response.headers['content-range']))) {
            errorLogger.warn('Unexpected response for range',
              rangeStart, response.headers['content-range'], response.statusCode);
            rangeIsSupported = false;
            rangeStart = undefined;
          }

          if (response.request.isAborted) {
            // Cancellation is reported through the request error event.
            return;
          }
          if (beforeWrite) {
            try {
              if (!await beforeWrite()) {
                request.once('end', () => resolve(response));
                request.resume();
                return;
              }
            } catch (error) {
              request.destroy(error as Error);
              reject(error);
              return;
            }
          }
          // Download body
          if (!fileWriteStream) {
            const flags = rejectSymlinks ? noFollowWriteFlags! : undefined;
            // Numeric open flags are supported at runtime but missing from Node 22 typings.
            fileWriteStream = createWriteStream(savePath, (rangeIsSupported && rangeStart ?
              {flags: flags === undefined ? 'a' : (flags & ~constants.O_TRUNC) | constants.O_APPEND,
                start: rangeStart, highWaterMark: 256 * 1024} :
              {flags: flags ?? 'w', highWaterMark: 256 * 1024}) as Parameters<typeof createWriteStream>[1]);
          }

          const pumping = maxResourceBytes === undefined ? pipeline(request, fileWriteStream) :
            pipeline(request, limitResourceStream(maxResourceBytes, rangeStart || 0), fileWriteStream);
          activePumps.add(pumping);
          try {
            await pumping;
          } catch (e) {
            // Request errors also arrive on request.once('error'); write errors do not.
            // Got closes the previous stream when retrying.
            if (!isRetry && !shouldWaitForRequestError(e)) {
              reject(e);
            }
            return;
          } finally {
            activePumps.delete(pumping);
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
          } else if (!rangeIsSupported) {
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

          reject(error);
        };

        request.once('error', onError);

        request.once('retry', (newRetryCount: number) => {
          isRetry = true;
          destroyStream();
          void Promise.allSettled(activePumps).then(() => {
            try { makeRequest(newRetryCount); } catch (error) { reject(error); }
          });
        });

      };

      makeRequest(0);
    });
  } finally {
    finished = true;
    await Promise.allSettled(activePumps);
    // Got streams disable autoDestroy. Release their abort listener after EOF,
    // rather than retaining completed requests until the downloader is disposed.
    activeRequest?.destroy();
  }
}

export async function optionallySetLastModifiedTime(
  res: Resource, options: StaticDownloadOptions, stagingPath?: string
): Promise<void> {
  // https://github.com/website-local/website-scrap-engine/issues/174
  let mtime: number | void = void 0;
  if (options.preferRemoteLastModifiedTime && res.meta?.headers?.['last-modified']) {
    mtime = Date.parse(res.meta.headers?.['last-modified']) / 1000;
  }

  // void and NaN check
  if (mtime) {
    const savePath = stagingPath ?? safeJoin(res.localRoot, decodeURI(res.savePath));
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
  options: StaticDownloadOptions,
  executor?: PipelineExecutor
): Promise<Resource | DownloadResource | void> {
  if (res.body !== undefined) {
    return res as DownloadResource;
  }
  if (res.type !== ResourceType.StreamingBinary) {
    return res;
  }
  // Only http(s) links are downloadable via got.stream(). A non-http link
  // (e.g. file://) must fall through unchanged so the next download handler
  // (readOrCopyLocalResource) can pick it up. Mirrors the same guard in
  // downloadStreamingResourceWithHook.
  if (!isUrlHttp(res.downloadLink)) {
    return res;
  }
  if (!res.downloadStartTimestamp) {
    res.downloadStartTimestamp = Date.now();
    res.waitTime = res.downloadStartTimestamp - res.createTimestamp;
  }
  const response = await streamingDownloadToFile(
    res as (Resource & { downloadStartTimestamp: number }), requestOptions, executor, options);
  if (response?.statusCode === 304) {
    return;
  }

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
  (e: Error | unknown, res: Resource, requestOptions: RequestOptions,
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
    if (res.body !== undefined) {
      return res as DownloadResource;
    }
    if (res.type !== ResourceType.StreamingBinary) {
      return res;
    }
    if (!isUrlHttp(res.downloadLink)) {
      return res;
    }
    if (beforeDownload) {
      const resource = await beforeDownload(res, requestOptions, options, pipeline);
      if (!resource) {
        return;
      }
      if (resource.body !== undefined) {
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
    try {
      const response = await streamingDownloadToFile(
        res as (Resource & { downloadStartTimestamp: number }), requestOptions, pipeline, options);
      if (response?.statusCode === 304) {
        return;
      }
    } catch (e) {
      if (!downloadError) {
        throw e;
      }
      await downloadError(e, res, requestOptions, options, pipeline);
      // The error hook observes a failure; it supplies no replacement response.
      throw e;
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
