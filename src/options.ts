import type {RequestError, RetryFunction, RetryObject, TimeoutError} from 'got';
import got, {Options} from 'got';
import {isDeepStrictEqual} from 'node:util';
import type {ResourceEncoding, ResourceType} from './resource.js';
import {createResource} from './resource.js';
import type {ProcessingLifeCycle, RequestOptions} from './life-cycle/types.js';
// noinspection ES6PreferShortImport
import {beforeRetryHook} from './life-cycle/download-resource.js';
import {error} from './logger/logger.js';
// noinspection ES6PreferShortImport
import {adjust} from './downloader/adjust-concurrency.js';
import type {Logger} from './logger/types.js';
import {createDefaultLogger} from './logger/default-logger.js';
import type {DownloaderWithMeta} from './downloader/types.js';
import type {SourceDefinition} from './sources.js';
import type {CheerioOptionsInterface} from './types.js';

/**
 * Extra options for custom life cycle
 */
export interface StaticDownloadMeta
  extends Record<string, string | number | boolean| void> {
  detectIncompleteHtml?: '</html>' | '</body>' | string;
  warnForNonHtml?: boolean;
}

/**
 * Options which should not be changed at runtime, and safe for cloning
 */
export interface StaticDownloadOptions {
  /** Opt-in native GET/HEAD transport; unsupported request options fall back to Got. Default: got. */
  httpTransport?: 'got' | 'native';
  /**
   * @see Resource.localRoot
   */
  localRoot: string;
  /** Re-resolve the root and prepare/check parents on every write instead of caching per crawl.
   * Atomic publication always rechecks its parent. Default: false.
   */
  strictOutputChecks?: boolean;
  /** Stage output and rename only on success. Default: false (direct writes may leave partial files). */
  atomicWrites?: boolean;
  /** Multi-thread only: initialize workers before init resolves. Default: false (on first worker task). */
  waitForWorkers?: boolean;

  /**
   * Local source path to download from,
   * if empty or undefined, file:// url would not be accepted,
   * this should not start with file://
   * Note: must use slash (/) on windows
   * https://github.com/website-local/website-scrap-engine/issues/126
   */
  localSrcRoot?: string;

  /**
   * Maximum recursive depth
   * @see Resource.depth
   */
  maxDepth: number;

  /**
   * Downloading concurrency
   */
  concurrency: number;

  /**
   * Resource default encoding by type.
   *
   * Encoding of a resource can be changed at
   * {@link ProcessingLifeCycle.processBeforeDownload}
   */
  encoding: Partial<Record<ResourceType, ResourceEncoding>>;

  /**
   * WorkerPool.coreSize = Math.min(
   * {@link concurrency},
   * {@link workerCount}
   * )
   */
  workerCount?: number;

  /**
   * Minimum concurrency, for {@link DownloadOptions.adjustConcurrencyFunc}
   */
  minConcurrency?: number;
  /** Hard ceiling for initial and runtime downloader concurrency. */
  maxConcurrency?: number;
  /** Maximum admitted resources for this crawl; omitted means unlimited. */
  maxResources?: number;
  /** Maximum waiting resources (active tasks excluded); omitted means unlimited. */
  maxQueuedResources?: number;
  /** Maximum child submissions per parent, including duplicates and rejected admissions. */
  maxDiscoveredResources?: number;
  /** Maximum downloaded bytes per resource, including decompressed HTTP data. */
  maxResourceBytes?: number;
  /** Aggregate task-body/child-body reservation budget; not a process-heap limit. */
  maxBufferedBytes?: number;

  /**
   * If url search params should be stripped.
   * If false, saved file name would contains search or hash of search
   */
  deduplicateStripSearch?: boolean;

  /**
   * Optional parse option for cheerio
   */
  cheerioParse?: CheerioOptionsInterface;

  /**
   * Optional serialize option for cheerio
   */
  cheerioSerialize?: CheerioOptionsInterface;

  /**
   * Custom html sources
   */
  sources?: SourceDefinition[];

  /**
   * Got options
   *
   * Never include functions or class instances
   * with {@link StaticDownloadOptions}.
   * Configure them functions or class instances
   * using {@link DownloadOptions} only.
   * @see RequestOptions
   * @see got.mergeOptions
   */
  req?: RequestOptions;

  /**
   * Urls being pushed to pipeline with depth 0 and the url self as refUrl
   */
  initialUrl?: string[];

  /**
   * @see DownloadOptions.createLogger
   */
  logSubDir?: string;

  /**
   * @see StaticDownloadMeta
   */
  meta: StaticDownloadMeta;

  /**
   * true to skip replacePath processing in case of parser error
   * https://github.com/website-local/website-scrap-engine/issues/107
   * @see createResource
   */
  skipReplacePathError?: boolean;

  /**
   * Set last modified time of local saved file with value from the
   * Last-Modified http header, if available in response.
   *
   * https://developer.mozilla.org/docs/Web/HTTP/Headers/Last-Modified
   * https://github.com/website-local/website-scrap-engine/issues/174
   */
  preferRemoteLastModifiedTime?: boolean;
}

export interface DownloadOptions extends StaticDownloadOptions, ProcessingLifeCycle {
  /**
   * Functions or class callbacks can only be here.
   *
   * @see StaticDownloadOptions.req
   */
  req: RequestOptions;

  /**
   * Opt in to runtime concurrency adjustment. The built-in policy backs off on
   * stalls/slowdown and increases gradually, capped at maxConcurrency or the
   * configured initial concurrency. Custom callbacks may implement another policy.
   *
   * Note: this would not affect worker_threads
   */
  adjustConcurrencyPeriod?: number;
  adjustConcurrencyFunc?: (downloader: DownloaderWithMeta) => void;

  /**
   * Use a custom function to create a logger instance.
   * Defaults to {@link createDefaultLogger} (console-based).
   */
  createLogger?: (options: StaticDownloadOptions) => Logger;
}

export type ExtendedError = (TimeoutError | RequestError) & {
  retryLimitExceeded: boolean;
};

const MAX_RETRY_DELAY = 5000;

const retryErrorCodes: Set<string> = new Set([
  // One of the timeout limits were reached.
  'ETIMEDOUT',
  //  Connection was forcibly closed by a peer.
  'ECONNRESET',
  // Could not bind to any free port.
  'EADDRINUSE',
  // Connection was refused by the server.
  'ECONNREFUSED',
  // The remote side of the stream being written has been closed.
  'EPIPE',
  // Couldn't resolve the hostname to an IP address.
  'ENOTFOUND',
  // No internet connection.
  'ENETUNREACH',
  // DNS lookup timed out.
  'EAI_AGAIN',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ESERVFAIL'
]);

/**
 * If you would like to implement it yourself,
 * set error.retryLimitExceeded to 1 or true
 * if attemptCount > retryOptions.limit
 * or you think retry should end
 */
export const calculateFastDelay: RetryFunction = (retryObject: RetryObject): number => {
  const {attemptCount, retryOptions, error: err} = retryObject;

  if (attemptCount > retryOptions.limit) {
    (err as ExtendedError).retryLimitExceeded = true;
    return 0;
  } else {
    (err as ExtendedError).retryLimitExceeded = false;
  }

  const hasMethod: boolean = err.options &&
    (retryOptions.methods.length ?
      retryOptions.methods.includes(err.options.method) :
      err.options.method === 'GET');
  const hasErrorCode = err.code &&
    (retryOptions.errorCodes.length ?
      retryOptions.errorCodes.includes(err.code) :
      retryErrorCodes.has(err.code as string));
  const hasStatusCode: undefined | boolean = retryOptions.statusCodes &&
    err.response &&
    retryOptions.statusCodes.includes(err.response.statusCode);
  if (!hasMethod || (!hasErrorCode && !hasStatusCode &&
    err.name !== 'ReadError' && err.name !== 'TimeoutError')) {

    if (err && !((err.name === 'HTTPError' &&
      err.response && err.response.statusCode === 404))) {
      error.error('calculateDelay SKIPPED',
        err.name, err.code, (err as TimeoutError).event, err.message,
        err.response && err.response.statusCode);
    }
    return 0;
  }
  let delay: number = ((2 * (attemptCount - 1)) * 1000) + Math.random() * 200;
  if (attemptCount > 2) {
    delay += 1000;
  }
  if (delay > MAX_RETRY_DELAY) {
    delay = MAX_RETRY_DELAY + (Math.random() - 0.5) * 1000;
  }
  // 429 Too Many Requests
  if (err.name === 'HTTPError' &&
    err.response && err.response.statusCode === 429) {
    // add random delay
    delay += 3000 + Math.random() * 3000;
    if (err.response.headers &&
      err.response.headers['retry-after']) {
      let retryAfter = parseInt(err.response.headers['retry-after']);
      if (Number.isNaN(retryAfter)) {
        retryAfter = Date.parse(err.response.headers['retry-after']) - Date.now();
      } else {
        retryAfter *= 1000;
      }
      if (!isNaN(retryAfter)) {
        retryAfter |= 0;
        if (retryAfter < 0) {
          retryAfter = 1;
        }
        if (retryOptions.maxRetryAfter) {
          if (retryAfter <= retryOptions.maxRetryAfter) {
            delay = retryAfter;
          }
        } else {
          delay = retryAfter;
        }
      }
    }
  }
  delay |= 0;
  return delay;
};

const defaultOptions: DownloadOptions = {
  init: [],
  dispose: [],
  concurrency: 12,
  createLogger: createDefaultLogger,
  createResource,
  detectResourceType: [],
  download: [],
  generateSavePath: [],
  // hack: force cast
  encoding: {} as DownloadOptions['encoding'],
  linkRedirect: [],
  localRoot: '',
  maxDepth: 1,
  meta: {
    detectIncompleteHtml: '</html>',
    warnForNonHtml: true
  },
  processAfterDownload: [],
  processBeforeDownload: [],
  req: {},
  saveToDisk: [],
  deduplicateStripSearch: true,
  statusChange: []
};

/** Copy configuration containers without cloning functions, agents, or cookie jars. */
function cloneConfig<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneConfig) as T;
  if (value && typeof value === 'object' &&
      Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(
      ([key, item]) => [key, cloneConfig(item)])) as T;
  }
  return value;
}

const requestDefaults = got.defaults.options.toJSON();
// Weak keys retain no merge history. A private copy detects callers mutating
// a previously normalized request object before another downloader uses it.
const normalizedRequests = new WeakMap<RequestOptions, RequestOptions>();

function snapshotOptions(options: Options, explicit: RequestOptions): RequestOptions {
  // Got takes the request URL as its first argument, never as an options key.
  const {url, ...snapshot} = options.toJSON();
  void url;
  // Do not turn every Got default into an explicit per-request override. That
  // makes Got clone and validate dozens of unchanged settings on every request.
  // Retain supplied keys and any settings changed by init hooks.
  const defaults = requestDefaults as Record<string, unknown>;
  return Object.fromEntries(Object.entries(snapshot).filter(([key, value]) =>
    Object.hasOwn(explicit, key) || !isDeepStrictEqual(value, defaults[key]))) as RequestOptions;
}

export function defaultDownloadOptions(
  options: ProcessingLifeCycle & Partial<DownloadOptions>): DownloadOptions {
  const merged: DownloadOptions = {...defaultOptions, ...options};
  if (merged.httpTransport !== undefined && merged.httpTransport !== 'got' && merged.httpTransport !== 'native') {
    throw new TypeError('Unknown httpTransport: ' + merged.httpTransport);
  }
  merged.meta = {...(options.meta ?? defaultOptions.meta)};
  merged.encoding = {...options.encoding};
  merged.req = cloneConfig(options.req ?? {});
  merged.req.headers ??= {};
  merged.initialUrl = options.initialUrl?.slice();
  for (const key of ['init', 'dispose', 'linkRedirect', 'detectResourceType',
    'generateSavePath', 'download', 'processAfterDownload',
    'processBeforeDownload', 'saveToDisk', 'statusChange'] as const) {
    merged[key] = [...(options[key] ?? defaultOptions[key])] as never;
  }
  if (!merged.concurrency || merged.concurrency < 1) {
    merged.concurrency = 12;
  }
  for (const key of ['concurrency', 'minConcurrency', 'maxConcurrency',
    'maxResources', 'maxQueuedResources', 'maxDiscoveredResources', 'maxResourceBytes', 'maxBufferedBytes',
    'adjustConcurrencyPeriod'] as const) {
    const value = merged[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError(`${key} must be a positive safe integer`);
    }
  }
  if (merged.maxConcurrency !== undefined) {
    if (merged.minConcurrency !== undefined && merged.minConcurrency > merged.maxConcurrency) {
      throw new RangeError('minConcurrency exceeds maxConcurrency');
    }
    merged.concurrency = Math.min(merged.concurrency, merged.maxConcurrency);
  }
  if (merged.adjustConcurrencyPeriod !== undefined && merged.adjustConcurrencyPeriod > 2147483647) {
    throw new RangeError('adjustConcurrencyPeriod exceeds the Node timer limit');
  }
  if (!merged.req.hooks) {
    merged.req.hooks = {};
  }
  if (!merged.req.hooks.beforeRetry) {
    merged.req.hooks.beforeRetry = [beforeRetryHook];
  }
  if (!('maxRedirects' in merged.req)) {
    merged.req.maxRedirects = 15;
  }
  if (!('ignoreInvalidCookies' in merged.req)) {
    merged.req.ignoreInvalidCookies = true;
  }
  if (!('timeout' in merged.req) || merged.req.timeout === undefined) {
    merged.req.timeout = merged.httpTransport === 'native' ? {request: 200000} : {
      lookup: 1000,
      connect: 3500,
      secureConnect: 4000,
      socket: 5000,
      send: 3000,
      response: 190000,
      request: 200000
    };
  }
  if (!('retry' in merged.req) || merged.req.retry === undefined) {
    merged.req.retry = {
      limit: merged.httpTransport === 'native' ? 0 : 25,
      maxRetryAfter: 60000,
      calculateDelay: calculateFastDelay
    };
  } else if (typeof merged.req.retry === 'number') {
    merged.req.retry = {
      limit: merged.req.retry,
      maxRetryAfter: 60000,
      calculateDelay: calculateFastDelay
    };
  } else if (!merged.req.retry.calculateDelay) {
    merged.req.retry.calculateDelay = calculateFastDelay;
  }
  if (merged.req.retry && !merged.req.retry.errorCodes) {
    // Got 16 distinguishes truncated responses from socket resets. Keep strict
    // length validation and allow the same bounded retry policy to recover.
    merged.req.retry.errorCodes = [...(got.defaults.options.retry.errorCodes ?? []),
      'ERR_HTTP_CONTENT_LENGTH_MISMATCH'];
  }
  if (options.adjustConcurrencyPeriod &&
    options.adjustConcurrencyPeriod > 0 &&
    !options.adjustConcurrencyFunc) {
    merged.adjustConcurrencyFunc = adjust;
  }
  const previous = options.req && normalizedRequests.get(options.req);
  if (!previous || !isDeepStrictEqual(merged.req, previous)) {
    merged.req = snapshotOptions(new Options(merged.req), merged.req);
  }
  // Init hooks are observable and must still execute at every normalization.
  if (!merged.req.hooks?.init?.length) normalizedRequests.set(merged.req, cloneConfig(merged.req));
  return merged;
}

export function checkDownloadOptions(options: DownloadOptions): DownloadOptions {
  return defaultDownloadOptions(validateDownloadOptions(options));
}

function validateDownloadOptions(options: DownloadOptions): DownloadOptions {
  if (!options.concurrency || options.concurrency < 1) {
    throw new TypeError('Bad concurrency: ' + options.concurrency);
  }
  if (!options.localRoot) {
    throw new TypeError('localRoot is required');
  }
  if (options.localSrcRoot?.includes('\\')) {
    options.localSrcRoot = options.localSrcRoot.replace(/\\/g, '/');
  }
  if (!options.download || !options.download.length) {
    throw new TypeError('download life cycle is required');
  }
  if (!options.saveToDisk || !options.saveToDisk.length) {
    throw new TypeError('saveToDisk life cycle is required');
  }
  return options;
}

export function mergeOverrideOptions(
  options: DownloadOptions | (() => DownloadOptions),
  overrideOptions?: Partial<StaticDownloadOptions>): DownloadOptions {
  const opt: DownloadOptions = typeof options === 'function' ? options() : options;
  if (!overrideOptions) {
    return validateDownloadOptions(defaultDownloadOptions(opt));
  }
  const merged: DownloadOptions = Object.assign({}, opt, overrideOptions);
  if (opt.meta && overrideOptions.meta) {
    merged.meta = Object.assign({}, opt.meta, overrideOptions.meta);
  }
  if (opt.req && overrideOptions.req) {
    const options = got.defaults.options;
    const mergedOptions = new Options(opt.req, overrideOptions.req, options);
    // Public snapshot avoids retaining Options' merge history between requests.
    merged.req = snapshotOptions(mergedOptions, {...opt.req, ...overrideOptions.req});
  }
  return validateDownloadOptions(defaultDownloadOptions(merged));
}
