import type {RequestError, RetryFunction, RetryObject, TimeoutError} from 'got';
import got, {Options} from 'got';
import {isDeepStrictEqual} from 'node:util';
import type {ResourceEncoding, ResourceType} from './resource.js';
import {createResource} from './resource.js';
import type {ProcessingLifeCycle, RequestOptions} from './life-cycle/types.js';
// noinspection ES6PreferShortImport
import {beforeRetryHook, downloadResource, downloadResourceDirect, downloadNativeResource} from './life-cycle/download-resource.js';
import {downloadStreamingResource, downloadNativeStreamingResource,
  downloadStreamingResourceDirect, downloadStreamingResourceWithSavePolicy,
  downloadNativeStreamingResourceWithSavePolicy} from './life-cycle/download-streaming-resource.js';
import {readOrCopyLocalResource, readOrCopyLocalResourceWithSavePolicy} from './life-cycle/read-or-copy-local-resource.js';
import {needsHttpCacheSafety} from './life-cycle/retry-hook.js';
import {error} from './logger/logger.js';
// noinspection ES6PreferShortImport
import {adjust} from './downloader/adjust-concurrency.js';
import type {Logger} from './logger/types.js';
import {createDefaultLogger} from './logger/default-logger.js';
import type {DownloaderWithMeta} from './downloader/types.js';
import type {SourceDefinition} from './sources.js';
import type {CheerioOptionsInterface} from './types.js';
import type {HtmlParserOptions} from './cheerio.js';

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
  /** Opt-in native GET/HEAD transport; unsupported request options use Got. */
  httpTransport?: 'got' | 'native';
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
   * Wait for this.init in method onIdle.
   * See https://github.com/website-local/website-scrap-engine/issues/152
   * @deprecated since 0.8.2
   */
  waitForInitBeforeIdle?: boolean;

  /**
   * Set last modified time of local saved file with value from the
   * Last-Modified http header, if available in response.
   *
   * https://developer.mozilla.org/docs/Web/HTTP/Headers/Last-Modified
   * https://github.com/website-local/website-scrap-engine/issues/174
   */
  preferRemoteLastModifiedTime?: boolean;
}

export interface DownloadOptions extends StaticDownloadOptions, HtmlParserOptions, ProcessingLifeCycle {
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
      if (Number.isFinite(retryAfter)) {
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
  // Got treats zero as cancellation. Avoid signed wrap and timer overflow.
  return Math.max(1, Math.min(2147483647, Math.trunc(delay)));
};

const defaultMeta: StaticDownloadMeta = {
  detectIncompleteHtml: '</html>',
  warnForNonHtml: true
};

/** Clone plain settings; keep opaque services such as agents and cookie jars live. */
function cloneConfig<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneConfig) as T;
  if (Object.getPrototypeOf(value) === Object.prototype) {
    // Object spread copies own data properties, including __proto__, without
    // changing the prototype. Only nested objects need recursive work.
    const copy = {...value} as Record<string, unknown>;
    for (const key of Object.keys(copy)) {
      const item = copy[key];
      if (item && typeof item === 'object') copy[key] = cloneConfig(item);
    }
    return copy as T;
  }
  return value;
}

function snapshotOptions(options: Options, explicit: RequestOptions,
  hasInitHooks = !!explicit.hooks?.init?.length): RequestOptions {
  // Got upgrades must preserve this public snapshot's hooks/agents and omitted
  // defaults. Check options.spec.ts, especially cross-key normalization and
  // repeated merges; retaining Options itself retains its _init merge history.
  const snapshot = options.toJSON() as Record<string, unknown>;
  // Explicit defaults cause Got to clone and validate them on every request.
  // Retain supplied keys and settings changed by an init hook only.
  const result: Record<string, unknown> = {};
  if (!hasInitHooks) {
    // Without init hooks, setters normalize supplied keys only. Got owns all
    // omitted defaults; copying them back would repeat their work per request.
    for (const key of Object.keys(explicit)) {
      if (key !== 'url' && Object.hasOwn(snapshot, key)) result[key] = snapshot[key];
    }
    return result as RequestOptions;
  }
  const defaults = got.defaults.options.toJSON() as Record<string, unknown>;
  for (const key of Object.keys(snapshot)) {
    if (key === 'url') continue;
    const value = snapshot[key];
    if ((key in explicit) || !isDeepStrictEqual(value, defaults[key])) result[key] = value;
  }
  return result as RequestOptions;
}

export function defaultDownloadOptions(
  options: ProcessingLifeCycle & Partial<DownloadOptions>
): DownloadOptions {
  return createDownloadOptions(options, false);
}

function createDownloadOptions(
  options: ProcessingLifeCycle & Partial<DownloadOptions>, requestNormalized = false
): DownloadOptions {
  const merged: DownloadOptions = {
    ...options,
    concurrency: options.concurrency ?? 12,
    createLogger: options.createLogger ?? createDefaultLogger,
    localRoot: options.localRoot ?? '',
    maxDepth: options.maxDepth ?? 1,
    deduplicateStripSearch: options.deduplicateStripSearch ?? true,
    createResource: options.createResource ?? createResource,
    meta: {...(options.meta ?? defaultMeta)},
    encoding: {...options.encoding},
    req: options.req == null ? {} : cloneConfig(options.req),
    init: options.init?.slice() ?? [],
    dispose: options.dispose?.slice() ?? [],
    linkRedirect: options.linkRedirect?.slice() ?? [],
    detectResourceType: options.detectResourceType?.slice() ?? [],
    download: options.download?.slice() ?? [],
    processAfterDownload: options.processAfterDownload?.slice() ?? [],
    processBeforeDownload: options.processBeforeDownload?.slice() ?? [],
    saveToDisk: options.saveToDisk?.slice() ?? [],
    statusChange: options.statusChange?.slice() ?? []
  };
  if (options.initialUrl) merged.initialUrl = options.initialUrl.slice();
  if (merged.loadHtml !== undefined && typeof merged.loadHtml !== 'function') {
    throw new TypeError('loadHtml must be a function');
  }
  if (merged.httpTransport !== undefined && merged.httpTransport !== 'got' && merged.httpTransport !== 'native') {
    throw new TypeError('Unknown httpTransport: ' + merged.httpTransport);
  }
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
  if (merged.req.retry === undefined || typeof merged.req.retry === 'number') {
    merged.req.retry = {
      limit: merged.req.retry ?? (merged.httpTransport === 'native' ? 2 : 25),
      maxRetryAfter: 60000
    };
  }
  if (!merged.req.retry.calculateDelay) {
    merged.req.retry.calculateDelay = merged.httpTransport === 'native' ?
      got.defaults.options.retry.calculateDelay : calculateFastDelay;
  }
  if (!merged.req.retry.errorCodes) {
    // Got 16 distinguishes truncated bodies from a socket reset.
    // Recheck this code and resumed-stream tests when Got changes body errors.
    merged.req.retry.errorCodes = [...(got.defaults.options.retry.errorCodes ?? []),
      'ERR_HTTP_CONTENT_LENGTH_MISMATCH'];
  }
  if (options.adjustConcurrencyPeriod &&
    options.adjustConcurrencyPeriod > 0 &&
    !options.adjustConcurrencyFunc) {
    merged.adjustConcurrencyFunc = adjust;
  }
  if (!requestNormalized && (merged.req.hooks?.init?.length || merged.httpTransport === 'native')) {
    // Eager validation is needed for init-hook effects and native fallback.
    // On Got upgrades verify ordinary requests still validate before I/O;
    // constructing Options for every default configuration reintroduces cost.
    merged.req = snapshotOptions(new Options(merged.req), merged.req);
  }
  selectDownloadHandlers(merged);
  return merged;
}

/** Reselect after enabling cache/hooks at runtime, including in lifecycle callbacks. */
export function selectDownloadHandlers(options: DownloadOptions): void {
  if (!options.download.length) return;
  const native = options.httpTransport === 'native';
  const guarded = native || needsHttpCacheSafety(options.req);
  for (let index = 0; index < options.download.length; index++) {
    const hook = options.download[index];
    let selected = hook;
    if (hook === downloadResource || hook === downloadResourceDirect || hook === downloadNativeResource) {
      const useNative = native || hook === downloadNativeResource && options.httpTransport !== 'got';
      selected = useNative ? downloadNativeResource : guarded ? downloadResource : downloadResourceDirect;
    } else if (hook === downloadStreamingResource || hook === downloadStreamingResourceDirect ||
        hook === downloadStreamingResourceWithSavePolicy ||
        hook === downloadNativeStreamingResource ||
        hook === downloadNativeStreamingResourceWithSavePolicy) {
      const useNative = native || options.httpTransport !== 'got' &&
        (hook === downloadNativeStreamingResource || hook === downloadNativeStreamingResourceWithSavePolicy);
      selected = options.existingResource ?
        (useNative ? downloadNativeStreamingResourceWithSavePolicy : downloadStreamingResourceWithSavePolicy) :
        useNative ? downloadNativeStreamingResource : guarded ? downloadStreamingResource : downloadStreamingResourceDirect;
    } else if (hook === readOrCopyLocalResource || hook === readOrCopyLocalResourceWithSavePolicy) {
      selected = options.existingResource ? readOrCopyLocalResourceWithSavePolicy : readOrCopyLocalResource;
    }
    if (selected !== hook) {
      if (Object.isFrozen(options.download)) options.download = options.download.slice();
      options.download[index] = selected;
    }
  }
}

export function checkDownloadOptions(options: DownloadOptions): DownloadOptions {
  const checked = defaultDownloadOptions(options);
  if (!checked.req.hooks?.init?.length && checked.httpTransport !== 'native') {
    checked.req = snapshotOptions(new Options(checked.req), checked.req);
  }
  return validateDownloadOptions(checked);
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
    // Reuse is not another normalization. Got validates the live settings when
    // issuing a request; callers can explicitly check configuration up front.
    // Shared hooks/settings/signals remain live; reuse does not rerun init hooks
    // or reset an aborted signal. Keep this identity contract on Got upgrades.
    return opt;
  }
  const merged: DownloadOptions = Object.assign({}, opt, overrideOptions);
  if (opt.meta && overrideOptions.meta) {
    merged.meta = Object.assign({}, opt.meta, overrideOptions.meta);
  }
  if (opt.req && overrideOptions.req) {
    const options = got.defaults.options;
    const hasInitHooks = !!(opt.req.hooks?.init?.length || overrideOptions.req.hooks?.init?.length);
    const mergedOptions = new Options(opt.req, overrideOptions.req, options);
    // A public snapshot avoids retaining Got's merge history across requests.
    merged.req = snapshotOptions(mergedOptions, {...opt.req, ...overrideOptions.req}, hasInitHooks);
  }
  // Got already validated this merge, including mutable settings and init hooks.
  // Do not reconstruct it or retain a second deep snapshot of the same settings.
  return validateDownloadOptions(createDownloadOptions(merged, !!(opt.req && overrideOptions.req)));
}
