import path from 'node:path';
import type {WriteStream} from 'node:fs';
import {createWriteStream, promises as fs} from 'node:fs';
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
import {mkdirRetry, safeJoin} from '../io.js';
import {error as errorLogger} from '../logger/logger.js';
import type {StaticDownloadOptions} from '../options.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {isUrlHttp} from '../util.js';
import type {NativeHttpResponse} from './native-http.js';
import type * as OptionalStreamingModule from './download-streaming-optional.js';
import {withHttpCacheSafety} from './retry-hook.js';

export function isBytesAccepted(acceptRange?: string): boolean {
  if (!acceptRange) {
    return false;
  }
  const ranges = acceptRange.split(',');
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i].trim().toLowerCase() === 'bytes') {
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

/** Direct-call convenience API; initialized lifecycle hooks use a fixed transport. */
export function streamingDownloadToFile(
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions,
  downloadOptions?: StaticDownloadOptions
): Promise<Response | NativeHttpResponse | void> {
  return (downloadOptions?.httpTransport === 'native' ? nativeStreamingDownloadToFile : gotStreamingDownloadToFile)(
    res, requestOptions);
}

type OptionalStreaming = typeof OptionalStreamingModule;
let optionalStreaming: Promise<OptionalStreaming> | undefined;

function loadOptionalStreaming(): Promise<OptionalStreaming> {
  return optionalStreaming ??= import('./download-streaming-optional.js');
}

async function nativeStreamingDownloadToFile(
  res: Resource & { downloadStartTimestamp: number }, requestOptions: RequestOptions
): Promise<Response | NativeHttpResponse | void> {
  return (await loadOptionalStreaming()).nativeStreamingDownloadToFile(res, requestOptions);
}

function gotStreamingDownloadToFile(
  res: Resource & {downloadStartTimestamp: number},
  requestOptions: RequestOptions
): Promise<Response | void> {
  return gotStreamingDownloadToFileDirect(res, withHttpCacheSafety(requestOptions));
}

async function gotStreamingDownloadToFileDirect(
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions
): Promise<Response | void> {
  // Got's retry event hands stream recreation to us. On upgrades, verify retry
  // count propagation, response/error ordering and partial-file range recovery
  // in download-streaming-resource.spec.ts, including abort and write failures.
  const savePath = safeJoin(res.localRoot, decodeURI(res.savePath));
  await mkdirRetry(path.dirname(savePath));
  const options = {...requestOptions,
    isStream: true, headers: {...requestOptions.headers}
  } as RequestOptions & {
    isStream?: true
  };
  let fileWriteStream: WriteStream | void = undefined;
  let activeRequest: ReturnType<typeof got.stream> | undefined;
  let handling: Promise<void> | undefined;
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

        const handleResponse = async (response: Response): Promise<void> => {
          try {
            response.retryCount = retryCount;
            if (response.statusCode === 304) {
              // Drain the response without opening or modifying the cached file.
              request.resume();
              await streamFinished(request, {cleanup: true});
              resolve(response);
              return;
            }
            res.meta.headers = response.headers;
            if (rangeIsSupported === undefined) {
              if (isBytesAccepted(response.headers['accept-ranges']) &&
                  (!response.headers['content-encoding'] || options.decompress === false)) {
                rangeIsSupported = true;
              }
            }
            if (rangeIsSupported && rangeStart &&
              (response.statusCode !== 206 ||
                !isSameRangeStart(rangeStart, response.headers['content-range']))) {
              errorLogger.warn('Unexpected response for range',
                rangeStart, response.headers['content-range'], response.statusCode);
              // A full 200 can replace the partial file. A misaligned 206 cannot.
              if (response.statusCode === 206) throw Object.assign(new Error('Unexpected response range'),
                {code: 'ERR_INVALID_RESPONSE_RANGE'});
              rangeIsSupported = false;
              rangeStart = undefined;
            }

            if (request.destroyed) {
              // Canceled while downloading
              //- will throw a `CancelError` or `TimeoutError` error
              return;
            }
            // Download body
            if (!fileWriteStream) {
              fileWriteStream = createWriteStream(savePath,
                rangeIsSupported && rangeStart ?
                  {flags: 'a', start: rangeStart, highWaterMark: 256 * 1024} :
                  {flags: 'w', highWaterMark: 256 * 1024});
            }

            try {
              // Download body directly to file
              await pipeline(request, fileWriteStream);
            } catch (e) {
              // Request errors also arrive on request.once('error'); write errors do not.
              // Got closes the previous stream when retrying.
              if (!isRetry && !shouldWaitForRequestError(e)) {
                reject(e);
              }
              return;
            }

            resolve(response);
          } catch (error) {
            request.destroy(error as Error);
            reject(error);
          }
        };
        request.once('response', (response: Response) => {
          handling = handleResponse(response);
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
          // Let pending writes settle before measuring the offset and reopening.
          void Promise.resolve(handling).then(() => {
            destroyStream();
            try { makeRequest(newRetryCount); } catch (error) { reject(error); }
          }, reject);
        });

      };

      makeRequest(0);
    });
  } finally {
    finished = true;
    try { await handling; }
    finally {
      // Got's stream disables autoDestroy; explicitly release its abort listener.
      activeRequest?.destroy();
      (fileWriteStream as WriteStream | undefined)?.destroy();
    }
  }
}

export async function optionallySetLastModifiedTime(
  res: Resource, options: StaticDownloadOptions
): Promise<void> {
  // https://github.com/website-local/website-scrap-engine/issues/174
  let mtime: number | void = void 0;
  if (options.preferRemoteLastModifiedTime && res.meta?.headers?.['last-modified']) {
    mtime = Date.parse(res.meta.headers?.['last-modified']) / 1000;
  }

  if (typeof mtime === 'number' && Number.isFinite(mtime)) {
    const savePath = safeJoin(res.localRoot, decodeURI(res.savePath));
    try {
      await fs.utimes(savePath, mtime, mtime);
    } catch (e) {
      errorLogger.warn('skipping utimes ' + savePath, e);
    }
  }
}

/** @internal Shared by the enabled-only streaming implementation. */
export function createStreamingDownloader(request: (
  res: Resource & { downloadStartTimestamp: number }, requestOptions: RequestOptions
) => Promise<Response | NativeHttpResponse | void>) {
  return async (
    res: Resource,
    requestOptions: RequestOptions,
    options: StaticDownloadOptions
  ): Promise<Resource | DownloadResource | true | void> => {
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
    const response = await request(
      res as (Resource & { downloadStartTimestamp: number }), requestOptions);
    if (response?.statusCode === 304) {
      return;
    }
    if (response) res.redirectedUrl = response.url;

    if (options.preferRemoteLastModifiedTime) await optionallySetLastModifiedTime(res, options);
    /// Not needed before
    // res.finishTimestamp = Date.now();
    // res.downloadTime =
    //   res.finishTimestamp - res.downloadStartTimestamp;
    return true;
  };
}

export const downloadStreamingResourceDirect = createStreamingDownloader(gotStreamingDownloadToFileDirect);
let guardedDownloader: typeof downloadStreamingResourceDirect | undefined;
export function downloadStreamingResource(
  res: Resource, requestOptions: RequestOptions, options: StaticDownloadOptions
): Promise<Resource | DownloadResource | true | void> {
  guardedDownloader ??= createStreamingDownloader(gotStreamingDownloadToFile);
  return guardedDownloader(res, requestOptions, options);
}
export async function downloadNativeStreamingResource(
  res: Resource, requestOptions: RequestOptions, options: StaticDownloadOptions
): Promise<Resource | DownloadResource | true | void> {
  return (await loadOptionalStreaming()).downloadNativeStreamingResource(res, requestOptions, options);
}

/** Selected during configuration only when an existing-resource policy is set. */
export function downloadStreamingResourceWithSavePolicy(
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor
): Promise<Resource | DownloadResource | true | void> {
  return downloadWithSavePolicy(res, requestOptions, options, pipeline, false);
}

export function downloadNativeStreamingResourceWithSavePolicy(
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor
): Promise<Resource | DownloadResource | true | void> {
  return downloadWithSavePolicy(res, requestOptions, options, pipeline, true);
}

async function downloadWithSavePolicy(
  res: Resource, requestOptions: RequestOptions, options: StaticDownloadOptions,
  pipeline: PipelineExecutor, native: boolean
): Promise<Resource | DownloadResource | true | void> {
  return (await loadOptionalStreaming()).downloadWithSavePolicy(res, requestOptions, options, pipeline, native);
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
  if (!beforeDownload && !afterDownload && !downloadError) return downloadStreamingResource;
  let download: DownloadResourceFunc | undefined;
  return async (res, requestOptions, options, pipeline) => {
    if (res.body !== undefined) return res as DownloadResource;
    if (res.type !== ResourceType.StreamingBinary || !isUrlHttp(res.downloadLink)) return res;
    download ??= (await loadOptionalStreaming()).downloadStreamingResourceWithHook(
      beforeDownload, afterDownload, downloadError);
    return download(res, requestOptions, options, pipeline);
  };
}
