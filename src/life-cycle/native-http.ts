import {request as httpRequest} from 'node:http';
import type {ClientRequest, IncomingHttpHeaders, IncomingMessage} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {addAbortListener} from 'node:events';
import type {Readable} from 'node:stream';
import {createBrotliDecompress, createGunzip, createInflate} from 'node:zlib';
import type {RequestOptions} from './types.js';
import {checkResourceSize} from '../resource-limits.js';
import {currentCrawlContext} from '../crawl-context.js';

/** Native mode exposes HTTP metadata, not Got's request implementation. */
export interface NativeHttpResponse {
  statusCode: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
  url: string;
  requestUrl: URL;
  redirectUrls: string[];
  retryCount: number;
}

export class NativeHttpError extends Error {
  readonly code = 'ERR_NON_2XX_3XX_RESPONSE';
  constructor(public readonly response: NativeHttpResponse) {
    super(`Response code ${response.statusCode} (${response.statusMessage})`);
    this.name = 'HTTPError';
  }
}

const supportedOptions = new Set(['headers', 'method', 'retry', 'timeout', 'signal',
  'followRedirect', 'maxRedirects', 'throwHttpErrors', 'decompress', 'responseType',
  'hooks', 'ignoreInvalidCookies']);

/** Decide before sending anything; unsupported configurations keep Got semantics. */
export function canUseNativeHttp(options: RequestOptions): boolean {
  if (Object.entries(options).some(([key, value]) => value !== undefined && !supportedOptions.has(key))) return false;
  if (options.method && options.method !== 'GET' && options.method !== 'HEAD') return false;
  if (options.retry?.limit !== 0) return false;
  if (options.followRedirect !== undefined && typeof options.followRedirect !== 'boolean') return false;
  const deadline = options.timeout?.request;
  if (deadline !== undefined && (!Number.isFinite(deadline) || deadline < 0 || deadline > 2147483647)) return false;
  if (options.timeout && Object.entries(options.timeout).some(([key, value]) => key !== 'request' && value !== undefined)) {
    return false;
  }
  // beforeRetry cannot run when retries are disabled. Every other Got hook
  // needs Got's request/response objects and therefore selects that backend.
  if (options.hooks && Object.entries(options.hooks).some(([key, hooks]) => key !== 'beforeRetry' && hooks?.length)) {
    return false;
  }
  return options.responseType === undefined || options.responseType === 'buffer';
}

export async function withNativeHttp<T>(
  url: string,
  options: RequestOptions,
  consume: (response: NativeHttpResponse, body: Readable) => Promise<T>
): Promise<T> {
  const requestUrl = new URL(url);
  let target = requestUrl;
  const headers = {...options.headers};
  if (options.decompress !== false && !Object.keys(headers).some(key => key.toLowerCase() === 'accept-encoding')) {
    headers['accept-encoding'] = 'gzip, deflate, br';
  }
  let request: ClientRequest | undefined;
  let incoming: IncomingMessage | undefined;
  let body: Readable | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    body?.destroy(error);
    request?.destroy(error);
  };
  options.signal?.throwIfAborted();
  const abort = options.signal ? addAbortListener(options.signal, () => fail(
    Object.assign(new Error('The operation was aborted', {cause: options.signal?.reason}),
      {name: 'AbortError', code: 'ABORT_ERR'}))) : undefined;
  const deadline = options.timeout?.request;
  const timer = deadline && Number.isFinite(deadline) ? setTimeout(() => fail(
    Object.assign(new Error(`Request timed out after ${deadline} ms`),
      {name: 'TimeoutError', code: 'ETIMEDOUT'})), deadline) : undefined;
  timer?.unref();
  const redirectUrls: string[] = [];
  try {
    for (;;) {
      if (failure) throw failure;
      incoming = await new Promise<IncomingMessage>((resolve, reject) => {
        const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
        request = send(target, {method: options.method ?? 'GET', headers}, resolve);
        request.once('error', reject);
        request.end();
      });
      // Cancellation may happen while a save-policy hook is still awaiting.
      // Retain errors until the body consumer attaches its own stream handlers.
      const current = incoming;
      incoming.on('error', error => { if (incoming === current) failure ??= error; });
      body = incoming;
      const statusCode = incoming.statusCode ?? 0;
      const location = incoming.headers.location;
      if (options.followRedirect !== false && location && [301, 302, 303, 307, 308].includes(statusCode)) {
        if (redirectUrls.length >= (options.maxRedirects ?? 15)) {
          throw Object.assign(new Error('Maximum redirect count exceeded'), {code: 'ERR_TOO_MANY_REDIRECTS'});
        }
        const next = new URL(Buffer.from(location, 'latin1').toString(), target);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('Unsupported redirect protocol');
        if (next.origin !== target.origin) {
          for (const key of Object.keys(headers)) {
            if (['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'host'].includes(key.toLowerCase())) delete headers[key];
          }
          next.username = '';
          next.password = '';
        }
        redirectUrls.push(next.href);
        incoming = undefined;
        body = undefined;
        current.destroy();
        request?.destroy();
        target = next;
        continue;
      }
      const response: NativeHttpResponse = {statusCode, statusMessage: incoming.statusMessage ?? '',
        headers: incoming.headers, url: target.href, requestUrl, redirectUrls, retryCount: 0};
      if (options.throwHttpErrors !== false && (statusCode < 200 || statusCode >= 300) && statusCode !== 304 &&
        !(options.followRedirect === false && statusCode >= 300 && statusCode < 400)) throw new NativeHttpError(response);
      if (options.decompress !== false && statusCode !== 204 && statusCode !== 304 &&
        incoming.headers['content-length'] !== '0' && options.method !== 'HEAD') {
        const encoding = incoming.headers['content-encoding']?.toLowerCase();
        const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() :
          encoding === 'br' ? createBrotliDecompress() : undefined;
        if (decoder) {
          decoder.on('error', error => { failure ??= error; });
          incoming.once('error', error => decoder.destroy(error));
          incoming.pipe(decoder);
          body = decoder;
        } else if (encoding && encoding !== 'identity') {
          throw Object.assign(new Error('Unsupported native content encoding: ' + encoding),
            {code: 'ERR_UNSUPPORTED_CONTENT_ENCODING'});
        }
      }
      return await consume(response, body);
    }
  } catch (error) {
    throw failure ?? error;
  } finally {
    if (timer) clearTimeout(timer);
    abort?.[Symbol.dispose]();
    body?.destroy();
    incoming?.destroy();
    request?.destroy();
  }
}

export function nativeBufferedRequest(url: string, options: RequestOptions, limit?: number):
  Promise<NativeHttpResponse & {body: Buffer}> {
  return withNativeHttp(url, options, async (response, body) => {
    const chunks: Buffer[] = [];
    const account = currentCrawlContext()?.bufferAccount;
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      checkResourceSize(size, limit);
      const accounting = account?.observeBody(size);
      if (accounting) await accounting;
      chunks.push(chunk);
    }
    return {...response, body: Buffer.concat(chunks, size)};
  });
}
