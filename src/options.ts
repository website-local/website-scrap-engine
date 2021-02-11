import got from 'got';
import type {
  RetryFunction,
  RetryObject,
  TimeoutError
} from 'got/dist/source/as-promise/types';
import type {RequestError} from 'got/dist/source/core';
import {createResource, ResourceEncoding, ResourceType} from './resource';
import type {ProcessingLifeCycle, RequestOptions} from './life-cycle/types';
// noinspection ES6PreferShortImport
import {beforeRetryHook} from './life-cycle/download-resource';
import {error} from './logger/logger';
// noinspection ES6PreferShortImport
import {adjust} from './downloader/adjust-concurrency';
import {configureLogger} from './logger/config-logger';
import type {DownloaderWithMeta} from './downloader/types';
import {weakAssign} from './util';
import type {SourceDefinition} from './sources';
import type {CheerioOptionsInterface} from './types';

/**
 * Extra options for custom life cycle
 */
export interface StaticDownloadMeta
  extends Record<string, string | number | boolean| void> {
  detectIncompleteHtml?: '</html>' | '</body>' | string;
}

/**
 * Options which should not be changed at runtime, and safe for cloning
 */
export interface StaticDownloadOptions {
  /**
   * @see Resource.localRoot
   */
  localRoot: string;

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
  encoding: Record<ResourceType, ResourceEncoding>;

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
   * @see DownloadOptions.configureLogger
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
   * Wait for this.init in method onIdle.
   * See https://github.com/website-local/website-scrap-engine/issues/152
   */
  waitForInitBeforeIdle?: boolean;
}

export interface DownloadOptions extends StaticDownloadOptions, ProcessingLifeCycle {
  /**
   * Functions or class callbacks can only be here.
   *
   * @see StaticDownloadOptions.req
   */
  req: RequestOptions;

  /**
   * Adjust downloaded concurrency at runtime.
   *
   * Note: this would not affect worker_threads
   */
  adjustConcurrencyPeriod?: number;
  adjustConcurrencyFunc?: (downloader: DownloaderWithMeta) => void;

  /**
   * Use a custom function to configure logger.
   */
  configureLogger: typeof configureLogger;
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
          if (retryAfter >= retryOptions.maxRetryAfter) {
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
  configureLogger,
  createResource,
  detectResourceType: [],
  download: [],
  // hack: force cast
  encoding: {} as DownloadOptions['encoding'],
  linkRedirect: [],
  localRoot: '',
  maxDepth: 1,
  meta: {
    detectIncompleteHtml: '</html>'
  },
  processAfterDownload: [],
  processBeforeDownload: [],
  req: {},
  saveToDisk: [],
  deduplicateStripSearch: true
};

export function defaultDownloadOptions(
  options: ProcessingLifeCycle & Partial<DownloadOptions>): DownloadOptions {
  const merged: DownloadOptions = weakAssign(options, defaultOptions);
  // merged = weakAssign(merged, defaultOptions);
  if (!merged.concurrency || merged.concurrency < 1) {
    merged.concurrency = 12;
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
    merged.req.timeout = {
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
      limit: 25,
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
  if (options.adjustConcurrencyPeriod &&
    options.adjustConcurrencyPeriod > 0 &&
    !options.adjustConcurrencyFunc) {
    options.adjustConcurrencyFunc = adjust;
  }
  return merged;
}

export function checkDownloadOptions(options: DownloadOptions): DownloadOptions {
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
  return defaultDownloadOptions(options);
}

export function mergeOverrideOptions(
  options: DownloadOptions | (() => DownloadOptions),
  overrideOptions?: Partial<StaticDownloadOptions>): DownloadOptions {
  const opt: DownloadOptions = typeof options === 'function' ? options() : options;
  if (!overrideOptions) {
    return opt;
  }
  if (opt.meta && overrideOptions.meta) {
    overrideOptions.meta = Object.assign(opt.meta, overrideOptions.meta);
  }
  if (opt.req && overrideOptions.req) {
    overrideOptions.req =
      got.mergeOptions(opt.req, overrideOptions.req);
  }
  return checkDownloadOptions(Object.assign(opt, overrideOptions));
}
