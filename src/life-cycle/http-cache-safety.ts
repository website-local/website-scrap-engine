import type {BeforeRequestHook, OptionsInit} from 'got';
import {beforeRetryHook} from './retry-hook.js';

const bypassMaxStaleCache: BeforeRequestHook = options => {
  if (options.cache && /(?:^|,)\s*max-stale\s*(?:=|,|$)/i.test(
    String(options.headers['cache-control'] ?? ''))) {
    // GHSA-ch52-4w7c-c8xp: max-stale can revive entries whose freshness was
    // zeroed for security, including shared responses containing Set-Cookie.
    options.cache = undefined;
  }
};

/** Guard the final request headers, including changes made by caller hooks. */
export function withHttpCacheSafety<T extends OptionsInit>(options: T): T {
  const hooks = options.hooks;
  // No cache and no hooks that can enable it: retain the ordinary request path.
  if (!options.cache && !hooks?.init?.length && !hooks?.beforeRequest?.length &&
      !hooks?.beforeRedirect?.length && !hooks?.afterResponse?.length &&
      !hooks?.beforeRetry?.some(hook => hook !== beforeRetryHook)) return options;

  return {...options, hooks: {...hooks,
    beforeRequest: [...hooks?.beforeRequest ?? [], bypassMaxStaleCache]
  }};
}
