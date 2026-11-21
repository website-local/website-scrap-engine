import type {BeforeRequestHook, BeforeRetryHook, OptionsInit} from 'got';
import {retry as logger} from '../logger/logger.js';

export function logRetry(
  error: {name: string; message: string; code?: string; event?: string},
  url: string,
  retryCount: number | undefined
): void {
  const log = retryCount && retryCount > 1 ? logger.warn : logger.info;
  if (error.name === 'TimeoutError') {
    log.call(logger, retryCount, url, error.name, error.code, error.message, error.event);
  } else {
    log.call(logger, retryCount, url, error.name, error.code, error.message);
  }
}

/** Take logs before retry without retaining a request or its response. */
export const beforeRetryHook: BeforeRetryHook = (error, retryCount) => {
  if (error.options) logRetry(error, String(error.options.url), retryCount);
};

const bypassMaxStaleCache: BeforeRequestHook = options => {
  // GHSA-ch52-4w7c-c8xp: bypass unsafe max-stale handling in http-cache-semantics.
  // Reassess on Got/cache dependency upgrades; keep http-cache-safety.spec.ts
  // passing for hooks, redirects and retries before retiring this workaround.
  if (options.cache && /(?:^|,)\s*max-stale\s*(?:=|,|$)/i.test(
    String(options.headers['cache-control'] ?? ''))) {
    options.cache = undefined;
  }
};

/** Guard final headers only when a cache or a hook can enable HTTP caching. */
export function needsHttpCacheSafety(options: OptionsInit): boolean {
  const hooks = options.hooks;
  if (options.cache || hooks?.init?.length || hooks?.beforeRequest?.length ||
    hooks?.beforeRedirect?.length || hooks?.afterResponse?.length) return true;
  const beforeRetry = hooks?.beforeRetry;
  if (!beforeRetry?.length) return false;
  if (beforeRetry.length === 1) return beforeRetry[0] !== beforeRetryHook;
  return beforeRetry.some(hook => hook !== beforeRetryHook);
}

export function withHttpCacheSafety<T extends OptionsInit>(options: T): T {
  if (!needsHttpCacheSafety(options)) return options;
  const hooks = options.hooks;
  // This must run after caller hooks and before Got looks up the cached response.
  // Recheck hook/cache ordering if Got adds hooks or changes request preparation.
  return {...options, hooks: {...hooks,
    beforeRequest: [...hooks?.beforeRequest ?? [], bypassMaxStaleCache]
  }};
}
