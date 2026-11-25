import path from 'node:path';
import type {WriteStream} from 'node:fs';
import {createWriteStream} from 'node:fs';
import {finished as streamFinished, pipeline} from 'node:stream/promises';
import type {RequestError, Response} from 'got';
import got, {HTTPError} from 'got';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import type {DownloadResource, DownloadResourceFunc, RequestOptions} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import type {NativeHttpResponse, withNativeHttp} from './native-http.js';
import type * as NativeHttpModule from './native-http.js';
import type {StreamingBeforeDownloadHook, StreamingAfterDownloadHook, StreamingDownloadErrorHook} from './download-streaming-resource.js';
import {streamingDownloadToFile, isBytesAccepted, isSameRangeStart, shouldWaitForRequestError,
  optionallySetLastModifiedTime, createStreamingDownloader, downloadStreamingResource} from './download-streaming-resource.js';
import {mkdirRetry, safeJoin} from '../io.js';
import {error as errorLogger} from '../logger/logger.js';
import {isUrlHttp} from '../util.js';
import {withHttpCacheSafety} from './retry-hook.js';
import {disposeHtmlResource} from '../cheerio.js';

let nativeHttp: typeof NativeHttpModule | undefined;

export async function nativeStreamingDownloadToFile(
  res: Resource & { downloadStartTimestamp: number },
  requestOptions: RequestOptions
): Promise<Response | NativeHttpResponse | void> {
  const native = nativeHttp ??= await import('./native-http.js');
  if (!native.canUseNativeHttp(requestOptions)) {
    res.meta.httpTransport = 'got';
    return streamingDownloadToFile(res, requestOptions);
  }
  res.meta.httpTransport = 'native';
  const savePath = safeJoin(res.localRoot, decodeURI(res.savePath));
  await mkdirRetry(path.dirname(savePath));
  return nativeStreamToFile(res, requestOptions, savePath, native.withNativeHttp);
}

function nativeStreamToFile(
  res: Resource,
  requestOptions: RequestOptions,
  savePath: string,
  request: typeof withNativeHttp
): Promise<NativeHttpResponse> {
  const options = {...requestOptions, headers: {...requestOptions.headers}};
  delete options.headers.range;
  let rangeIsSupported: boolean | undefined;
  let rangeStart = 0;
  return request(res.downloadLink, options, async (response, body) => {
    if (response.statusCode === 304) {
      body.resume();
      await streamFinished(body, {cleanup: true});
      return response;
    }
    res.meta.headers = response.headers;
    rangeIsSupported ??= isBytesAccepted(response.headers['accept-ranges']) &&
      (!response.headers['content-encoding'] || options.decompress === false);
    if (rangeIsSupported && rangeStart &&
        (response.statusCode !== 206 || !isSameRangeStart(rangeStart, response.headers['content-range']))) {
      if (response.statusCode === 206) throw Object.assign(new Error('Unexpected response range'),
        {code: 'ERR_INVALID_RESPONSE_RANGE'});
      rangeIsSupported = false;
      rangeStart = 0;
      delete options.headers.range;
    }
    if (body.destroyed) throw body.errored ?? new Error('Response closed before output was opened');
    const output = createWriteStream(savePath, {flags: rangeStart ? 'a' : 'w', highWaterMark: 256 * 1024});
    try {
      await pipeline(body, output);
    } catch (error) {
      if (rangeIsSupported) {
        rangeStart += output.bytesWritten;
        if (rangeStart) options.headers.range = `bytes=${rangeStart}-`;
      }
      throw error;
    }
    return response;
  });
}

interface StreamingSaveResult {
  response: Response | NativeHttpResponse;
  saved: boolean;
}

// These paths are selected only for configured save policies or streaming hooks.
// Keep policy waits and result bookkeeping out of the direct default transport.
async function gotStreamingDownloadWithSavePolicy(
  res: Resource & {downloadStartTimestamp: number},
  requestOptions: RequestOptions,
  executor: PipelineExecutor
): Promise<StreamingSaveResult> {
  // Keep Got retry/response handling aligned with the direct streaming handler
  // on upgrades; additionally verify skipped-save draining and cancellation.
  const savePath = safeJoin(res.localRoot, decodeURI(res.savePath));
  const options = withHttpCacheSafety({...requestOptions,
    isStream: true, headers: {...requestOptions.headers}
  } as RequestOptions & {isStream?: true});
  let fileWriteStream: WriteStream | undefined;
  let activeRequest: ReturnType<typeof got.stream> | undefined;
  let handling: Promise<void> | undefined;
  let finished = false;
  let saveAllowed: boolean | undefined;
  let directoryReady = false;

  try {
    return await new Promise<StreamingSaveResult>((resolve, reject) => {
      let rangeIsSupported: boolean | undefined;
      let rangeStart: number | undefined;
      const makeRequest = (retryCount: number): void => {
        if (finished) return;
        let isRetry = false;
        if (!rangeIsSupported && options.headers) {
          rangeStart = undefined;
          delete options.headers.range;
        } else if (rangeStart && rangeIsSupported) {
          options.headers ??= {};
          options.headers.range = `bytes=${rangeStart}-`;
        }
        const request = got.stream(res.downloadLink, options);
        activeRequest = request;
        request.retryCount = retryCount;

        const handleResponse = async (response: Response): Promise<void> => {
          try {
            response.retryCount = retryCount;
            if (response.statusCode === 304) {
              request.resume();
              await streamFinished(request, {cleanup: true});
              resolve({response, saved: false});
              return;
            }
            res.meta.headers = response.headers;
            // Decide once, before writing any bytes. A retry must not mistake
            // this download's partial output for a previously cached resource.
            saveAllowed ??= await executor.shouldSaveResource(res, savePath);
            if (request.destroyed) return;
            if (!saveAllowed) {
              try {
                request.resume();
                await streamFinished(request, {cleanup: true});
              } catch (error) {
                if (!isRetry && !shouldWaitForRequestError(error)) reject(error);
                return;
              }
              resolve({response, saved: false});
              return;
            }
            if (rangeIsSupported === undefined && isBytesAccepted(response.headers['accept-ranges']) &&
                (!response.headers['content-encoding'] || options.decompress === false)) {
              rangeIsSupported = true;
            }
            if (rangeIsSupported && rangeStart &&
                (response.statusCode !== 206 || !isSameRangeStart(rangeStart, response.headers['content-range']))) {
              errorLogger.warn('Unexpected response for range',
                rangeStart, response.headers['content-range'], response.statusCode);
              if (response.statusCode === 206) throw Object.assign(new Error('Unexpected response range'),
                {code: 'ERR_INVALID_RESPONSE_RANGE'});
              rangeIsSupported = false;
              rangeStart = undefined;
            }
            if (!directoryReady) {
              await mkdirRetry(path.dirname(savePath));
              directoryReady = true;
            }
            if (request.destroyed) return;
            if (!fileWriteStream) {
              fileWriteStream = createWriteStream(savePath,
                rangeIsSupported && rangeStart ?
                  {flags: 'a', start: rangeStart, highWaterMark: 256 * 1024} :
                  {flags: 'w', highWaterMark: 256 * 1024});
            }
            try {
              await pipeline(request, fileWriteStream);
            } catch (error) {
              if (!isRetry && !shouldWaitForRequestError(error)) reject(error);
              return;
            }
            resolve({response, saved: true});
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
            rangeStart = rangeIsSupported ? (rangeStart ?? 0) + fileWriteStream.bytesWritten : undefined;
            fileWriteStream.destroy();
          } else if (!rangeIsSupported) {
            rangeStart = undefined;
          }
          fileWriteStream = undefined;
        };
        request.once('error', (error: RequestError) => {
          if (error instanceof HTTPError && error.response.statusCode === 416) {
            errorLogger.warn('Unexpected response for range',
              rangeStart, error.response.headers['content-range'], error.response.statusCode);
            rangeIsSupported = false;
          }
          if (error instanceof HTTPError && !request.options.throwHttpErrors) {
            resolve({response: error.response, saved: false});
            return;
          }
          reject(error);
        });
        request.once('retry', (newRetryCount: number) => {
          isRetry = true;
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
      activeRequest?.destroy();
      (fileWriteStream as WriteStream | undefined)?.destroy();
    }
  }
}

async function nativeStreamingDownloadWithSavePolicy(
  res: Resource & {downloadStartTimestamp: number},
  requestOptions: RequestOptions,
  executor: PipelineExecutor
): Promise<StreamingSaveResult> {
  const native = nativeHttp ??= await import('./native-http.js');
  if (!native.canUseNativeHttp(requestOptions)) {
    res.meta.httpTransport = 'got';
    return gotStreamingDownloadWithSavePolicy(res, requestOptions, executor);
  }
  res.meta.httpTransport = 'native';
  const savePath = safeJoin(res.localRoot, decodeURI(res.savePath));
  const options = {...requestOptions, headers: {...requestOptions.headers}};
  delete options.headers.range;
  let saveAllowed: boolean | undefined;
  let directoryReady = false;
  let rangeIsSupported: boolean | undefined;
  let rangeStart = 0;
  return native.withNativeHttp(res.downloadLink, options, async (response, body) => {
    if (response.statusCode === 304) {
      body.resume();
      await streamFinished(body, {cleanup: true});
      return {response, saved: false};
    }
    res.meta.headers = response.headers;
    saveAllowed ??= await executor.shouldSaveResource(res, savePath);
    if (body.destroyed) throw body.errored ?? new Error('Response closed before output was opened');
    if (!saveAllowed) {
      body.resume();
      await streamFinished(body, {cleanup: true});
      return {response, saved: false};
    }
    rangeIsSupported ??= isBytesAccepted(response.headers['accept-ranges']) &&
      (!response.headers['content-encoding'] || options.decompress === false);
    if (rangeIsSupported && rangeStart &&
        (response.statusCode !== 206 || !isSameRangeStart(rangeStart, response.headers['content-range']))) {
      if (response.statusCode === 206) throw Object.assign(new Error('Unexpected response range'),
        {code: 'ERR_INVALID_RESPONSE_RANGE'});
      rangeIsSupported = false;
      rangeStart = 0;
      delete options.headers.range;
    }
    if (!directoryReady) {
      await mkdirRetry(path.dirname(savePath));
      directoryReady = true;
    }
    if (body.destroyed) throw body.errored ?? new Error('Response closed before output was opened');
    const output = createWriteStream(savePath, {flags: rangeStart ? 'a' : 'w', highWaterMark: 256 * 1024});
    try {
      await pipeline(body, output);
    } catch (error) {
      if (rangeIsSupported) {
        rangeStart += output.bytesWritten;
        if (rangeStart) options.headers.range = `bytes=${rangeStart}-`;
      }
      throw error;
    }
    return {response, saved: true};
  });
}

let nativeDownloader: ReturnType<typeof createStreamingDownloader> | undefined;
export function downloadNativeStreamingResource(
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions
): Promise<Resource | DownloadResource | true | void> {
  nativeDownloader ??= createStreamingDownloader(nativeStreamingDownloadToFile);
  return nativeDownloader(res, requestOptions, options);
}

export async function downloadWithSavePolicy(
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor,
  native: boolean
): Promise<Resource | DownloadResource | true | void> {
  if (res.body !== undefined) return res as DownloadResource;
  if (res.type !== ResourceType.StreamingBinary || !isUrlHttp(res.downloadLink)) return res;
  if (!res.downloadStartTimestamp) {
    res.downloadStartTimestamp = Date.now();
    res.waitTime = res.downloadStartTimestamp - res.createTimestamp;
  }
  const result = await (native ? nativeStreamingDownloadWithSavePolicy : gotStreamingDownloadWithSavePolicy)(
    res as Resource & {downloadStartTimestamp: number}, requestOptions, pipeline);
  if (result.response.statusCode === 304) return;
  res.redirectedUrl = result.response.url;
  if (result.saved && options.preferRemoteLastModifiedTime) await optionallySetLastModifiedTime(res, options);
  return true;
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
  ): Promise<Resource | DownloadResource | true | void> => {
    if (res.body !== undefined) {
      return res as DownloadResource;
    }
    if (res.type !== ResourceType.StreamingBinary) {
      return res;
    }
    if (!isUrlHttp(res.downloadLink)) {
      return res;
    }
    const original = res;
    let passedOn = false;
    let completed = false;
    let failed = false;
    let failure: unknown;
    try {
      if (beforeDownload) {
        const resource = await beforeDownload(res, requestOptions, options, pipeline);
        if (!resource) return;
        // The enclosing pipeline adopts returned bodies and owns their documents.
        if (resource.body !== undefined && !resource.shouldBeDiscardedFromDownload) {
          return resource as DownloadResource;
        }
        if (resource !== res) {
          res = resource;
          const replacing = pipeline.replaceResource(original, res);
          if (replacing) await replacing;
        }
        if (res.shouldBeDiscardedFromDownload) return;
        if (res.type !== ResourceType.StreamingBinary || !isUrlHttp(res.downloadLink)) {
          passedOn = true;
          return res;
        }
      }
      if (!res.downloadStartTimestamp) {
        res.downloadStartTimestamp = Date.now();
        res.waitTime = res.downloadStartTimestamp - res.createTimestamp;
      }
      try {
        const result = await (options.httpTransport === 'native' ?
          nativeStreamingDownloadWithSavePolicy : gotStreamingDownloadWithSavePolicy)(
          res as Resource & {downloadStartTimestamp: number}, requestOptions, pipeline);
        if (result.response.statusCode === 304) return;
        res.redirectedUrl = result.response.url;
        if (result.saved && options.preferRemoteLastModifiedTime) await optionallySetLastModifiedTime(res, options);
      } catch (error) {
        if (downloadError) await downloadError(error, res, requestOptions, options, pipeline);
        // An observer supplies no replacement response, so the download still failed.
        throw error;
      }
      res.finishTimestamp = Date.now();
      res.downloadTime = res.finishTimestamp - res.downloadStartTimestamp;
      if (afterDownload) {
        await afterDownload(res, requestOptions, options, pipeline);
      }
      completed = true;
      return true;
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      // A completed stream returns no resource to the enclosing pipeline. Release
      // an adopted replacement here; the pipeline still releases the original.
      if (res !== original && !passedOn) {
        try {
          const disposing = disposeHtmlResource(res);
          if (disposing) await disposing;
        } catch (cleanupError) {
          // Cleanup must reject even after a successful return; retain both failures.
          // eslint-disable-next-line no-unsafe-finally
          throw failed ? new AggregateError([failure, cleanupError], 'Resource cleanup failed', {cause: cleanupError}) : cleanupError;
        }
        if (completed) original.redirectedUrl = res.redirectedUrl;
      }
    }
  };
}
