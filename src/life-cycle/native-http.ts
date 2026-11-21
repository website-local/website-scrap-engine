import {request as httpRequest} from 'node:http';
import type {ClientRequest, IncomingHttpHeaders, IncomingMessage} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {addAbortListener} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import type {Readable} from 'node:stream';
import {createBrotliDecompress, createGunzip, createInflate} from 'node:zlib';
import got from 'got';
import type {RequestOptions} from './types.js';
import {beforeRetryHook, logRetry} from './retry-hook.js';

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
  constructor(public readonly response: NativeHttpResponse & {body?: Buffer}) {
    super(`Response code ${response.statusCode} (${response.statusMessage})`);
    this.name = 'HTTPError';
  }
}

const supportedOptions = new Set(['headers', 'method', 'retry', 'timeout', 'signal',
  'followRedirect', 'maxRedirects', 'throwHttpErrors', 'decompress', 'responseType',
  'hooks', 'ignoreInvalidCookies']);
const timerLimit = 2147483647;
const transportErrors = new WeakSet<Error>();

/** Decide before sending anything; unsupported settings keep Got semantics. */
export function canUseNativeHttp(options: RequestOptions): boolean {
  // Got upgrades can change defaults, hooks and option meanings. Recheck this
  // allowlist and native-http.spec.ts before accepting a new option; unsupported
  // requests must fall back before I/O, including custom retry calculators.
  if (Object.entries(options).some(([key, value]) => value !== undefined && !supportedOptions.has(key))) return false;
  if (options.method && options.method !== 'GET' && options.method !== 'HEAD') return false;
  const retry = options.retry as (typeof options.retry & {enforceRetryRules?: boolean});
  const retries = retry?.limit ?? 2;
  if (!Number.isSafeInteger(retries) || retries < 0) return false;
  if (retry?.enforceRetryRules === false ||
      retry?.calculateDelay && retry.calculateDelay !== got.defaults.options.retry.calculateDelay) return false;
  if (retry?.backoffLimit !== undefined && (retry.backoffLimit < 0 || Number.isNaN(retry.backoffLimit))) return false;
  if (retry?.noise !== undefined && (!Number.isFinite(retry.noise) || retry.noise < 0)) return false;
  if (retry?.maxRetryAfter !== undefined && (retry.maxRetryAfter < 0 || Number.isNaN(retry.maxRetryAfter))) return false;
  if (options.followRedirect !== undefined && typeof options.followRedirect !== 'boolean') return false;
  if (options.maxRedirects !== undefined && (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0)) return false;
  const deadline = options.timeout?.request;
  if (deadline !== undefined && (!Number.isFinite(deadline) || deadline < 0 || deadline > timerLimit)) return false;
  if (options.timeout && Object.entries(options.timeout).some(([key, value]) => key !== 'request' && value !== undefined)) {
    return false;
  }
  // Custom hooks may inspect or modify Got request/error objects.
  if (options.hooks && Object.entries(options.hooks).some(([key, hooks]) => hooks?.length &&
      (key !== 'beforeRetry' || retries && hooks.some(hook => hook !== beforeRetryHook)))) return false;
  return options.responseType === undefined || options.responseType === 'buffer';
}

function isResponseOk(response: NativeHttpResponse, options: RequestOptions): boolean {
  return response.statusCode === 304 || response.statusCode >= 200 &&
    response.statusCode <= (options.followRedirect === false ? 399 : 299);
}

export async function withNativeHttp<T>(
  url: string,
  options: RequestOptions,
  consume: (response: NativeHttpResponse, body: Readable) => Promise<T>,
  bufferHttpErrors = false
): Promise<T> {
  // Retry defaults come from the installed Got, but the algorithm is local.
  // Recheck its Retry-After/413/zero-delay behavior on Got upgrades, not only
  // the default values or retry count.
  const retry = options.retry;
  const defaults = got.defaults.options.retry;
  const limit = retry?.limit ?? defaults.limit ?? 2;
  for (let attempt = 0; ; ++attempt) {
    try {
      return await nativeHttpAttempt(url, options, async (response, body) => {
        response.retryCount = attempt;
        if (!bufferHttpErrors && options.throwHttpErrors !== false && !isResponseOk(response, options)) {
          // Got drains an HTTP error response before making its retry decision.
          for await (const chunk of body) void chunk;
          throw new NativeHttpError(response);
        }
        return consume(response, body);
      });
    } catch (error) {
      if (error instanceof NativeHttpError) error.response.retryCount = attempt;
      if (options.signal?.aborted || attempt >= limit ||
          !(retry?.methods ?? defaults.methods!).includes(options.method ?? 'GET')) throw error;
      const response = error instanceof NativeHttpError ? error.response : undefined;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!(response && (retry?.statusCodes ?? defaults.statusCodes!).includes(response.statusCode)) &&
          !((error instanceof NativeHttpError || transportErrors.has(error as Error)) && code &&
            (retry?.errorCodes ?? defaults.errorCodes!).includes(code))) throw error;
      const retryAfter = response?.headers['retry-after'];
      let wait: number | undefined;
      if (typeof retryAfter === 'string') {
        const seconds = Number(retryAfter);
        if (Number.isNaN(seconds)) {
          wait = Date.parse(retryAfter) - Date.now();
          if (wait <= 0) wait = 1;
        } else {
          wait = seconds * 1000;
        }
      }
      // Got treats a zero or malformed Retry-After as absent. A zero computed
      // backoff means "do not retry", rather than "retry immediately".
      if (wait) {
        if (wait > (retry?.maxRetryAfter ?? options.timeout?.request ?? Infinity)) throw error;
      } else {
        if (response?.statusCode === 413) throw error;
        wait = Math.min(2 ** attempt * 1000, retry?.backoffLimit ?? defaults.backoffLimit!) +
          Math.random() * (retry?.noise ?? defaults.noise!);
      }
      if (!wait || !Number.isFinite(wait) || wait > timerLimit) throw error;
      await delay(Math.max(1, wait), undefined, {signal: options.signal});
      if (options.hooks?.beforeRetry?.includes(beforeRetryHook)) {
        logRetry(error as Error & {code?: string; event?: string}, url, attempt + 1);
      }
    }
  }
}

async function nativeHttpAttempt<T>(
  url: string,
  options: RequestOptions,
  consume: (response: NativeHttpResponse, body: Readable) => Promise<T>
): Promise<T> {
  const requestUrl = new URL(url);
  if (requestUrl.protocol !== 'http:' && requestUrl.protocol !== 'https:') throw new TypeError('Unsupported HTTP protocol');
  let target = requestUrl;
  const headers: Record<string, string | string[]> = {};
  for (const source of [got.defaults.options.headers, options.headers]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === undefined) delete headers[key.toLowerCase()];
      else headers[key.toLowerCase()] = value;
    }
  }
  if (options.decompress !== false && headers['accept-encoding'] === undefined) {
    headers['accept-encoding'] = 'gzip, deflate, br';
  }
  let request: ClientRequest | undefined;
  let incoming: IncomingMessage | undefined;
  let body: Readable | undefined;
  let failure: Error | undefined;
  const remember = (error: Error) => {
    transportErrors.add(error);
    failure ??= error;
  };
  const fail = (error: Error) => {
    remember(error);
    body?.destroy(error);
    request?.destroy(error);
  };
  const aborted = () => Object.assign(new Error('The operation was aborted', {cause: options.signal?.reason}),
    {name: 'AbortError', code: 'ABORT_ERR'});
  if (options.signal?.aborted) throw aborted();
  const abort = options.signal ? addAbortListener(options.signal, () => fail(aborted())) : undefined;
  const deadline = options.timeout?.request;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const redirectUrls: string[] = [];
  try {
    for (;;) {
      if (failure) throw failure;
      if (timer) clearTimeout(timer);
      timer = deadline !== undefined ? setTimeout(() => fail(
        Object.assign(new Error(`Request timed out after ${deadline} ms`),
          {name: 'TimeoutError', code: 'ETIMEDOUT', event: 'request'})), deadline) : undefined;
      timer?.unref();
      incoming = await new Promise<IncomingMessage>((resolve, reject) => {
        const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
        request = send(target, {method: options.method ?? 'GET', headers}, resolve);
        request.once('error', error => { remember(error); reject(error); });
        request.end();
      });
      const current = incoming;
      const requestTimer = timer;
      incoming.once('end', () => { if (requestTimer) clearTimeout(requestTimer); });
      incoming.on('error', error => { if (incoming === current) remember(error); });
      body = incoming;
      const statusCode = incoming.statusCode ?? 0;
      const location = incoming.headers.location;
      if (options.followRedirect !== false && location && [301, 302, 303, 307, 308].includes(statusCode)) {
        if (redirectUrls.length >= (options.maxRedirects ?? 15)) {
          throw Object.assign(new Error('Maximum redirect count exceeded'), {code: 'ERR_TOO_MANY_REDIRECTS'});
        }
        const next = new URL(Buffer.from(location, 'latin1').toString(), target);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new TypeError('Unsupported redirect protocol');
        if (next.origin !== target.origin) {
          for (const key of ['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'host']) delete headers[key];
          next.username = '';
          next.password = '';
        } else {
          next.username = target.username;
          next.password = target.password;
        }
        redirectUrls.push(next.href);
        for await (const chunk of incoming) void chunk;
        incoming = undefined;
        body = undefined;
        target = next;
        continue;
      }
      const response: NativeHttpResponse = {statusCode, statusMessage: incoming.statusMessage ?? '',
        headers: incoming.headers, url: target.href, requestUrl, redirectUrls, retryCount: 0};
      if (options.decompress !== false && statusCode !== 204 && statusCode !== 304 &&
          incoming.headers['content-length'] !== '0' && options.method !== 'HEAD') {
        const encoding = incoming.headers['content-encoding']?.toLowerCase();
        const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() :
          encoding === 'br' ? createBrotliDecompress() : undefined;
        if (decoder) {
          decoder.on('error', remember);
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
    // Completed native messages release their sockets to Node's keep-alive
    // agent. Destroy only unfinished I/O; no signal listener survives either way.
    if (!incoming?.complete || !body?.readableEnded) {
      body?.destroy();
      incoming?.destroy();
      request?.destroy();
    }
  }
}

export async function nativeBufferedRequest(url: string, options: RequestOptions):
  Promise<NativeHttpResponse & {body: Buffer}> {
  try {
    return await withNativeHttp(url, options, async (response, body) => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        chunks.push(chunk);
      }
      const result = {...response, body: Buffer.concat(chunks, size)};
      // Buffered Got retries HTTP statuses even with throwHttpErrors: false,
      // then returns the final error response. Streaming Got does not retry them.
      if (!isResponseOk(response, options)) throw new NativeHttpError(result);
      return result;
    }, true);
  } catch (error) {
    if (options.throwHttpErrors === false && error instanceof NativeHttpError && error.response.body !== undefined) {
      return error.response as NativeHttpResponse & {body: Buffer};
    }
    throw error;
  }
}
