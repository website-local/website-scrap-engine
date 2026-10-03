import {describe, expect, jest, test} from '@jest/globals';
import type {BeforeRequestHook, RequestError, RetryObject} from 'got';
// noinspection ES6PreferShortImport
import {
  calculateFastDelay,
  defaultDownloadOptions,
  mergeOverrideOptions
} from '../src/options.js';
import {defaultLifeCycle} from '../src/life-cycle/default-life-cycle.js';

jest.mock('log4js', () => ({
  configure: jest.fn(),
  getLogger: jest.fn().mockReturnValue({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  }),
}));

function makeRetryObject(overrides: {
  attemptCount?: number;
  statusCode?: number;
  errorCode?: string;
  errorName?: string;
  method?: string;
  retryAfter?: string;
  limit?: number;
  maxRetryAfter?: number;
}): RetryObject {
  const {
    attemptCount = 1,
    statusCode = 500,
    errorCode = 'ETIMEDOUT',
    errorName = 'RequestError',
    method = 'GET',
    retryAfter,
    limit = 3,
    maxRetryAfter,
  } = overrides;
  const headers: Record<string, string> = {};
  if (retryAfter !== undefined) {
    headers['retry-after'] = retryAfter;
  }
  return {
    attemptCount,
    retryOptions: {
      limit,
      methods: ['GET'],
      statusCodes: [429, 500, 502, 503],
      errorCodes: ['ETIMEDOUT', 'ECONNRESET'],
      maxRetryAfter,
    },
    error: {
      name: errorName,
      code: errorCode,
      message: 'test error',
      options: {method, url: 'http://example.com'},
      response: {statusCode, headers},
    } as unknown as RequestError,
    computedValue: 0,
  } as unknown as RetryObject;
}

describe('mergeOverrideOptions', () => {
  test('preserves cloneable overrides when merging module request hooks', () => {
    const beforeRequest = () => {};
    const base = defaultDownloadOptions({
      ...defaultLifeCycle(),
      localRoot: 'root',
      req: {
        headers: {'x-base': 'base'},
        hooks: {beforeRequest: [beforeRequest]}
      },
      meta: Object.freeze({base: true})
    });
    const overrides = Object.freeze({
      concurrency: 2,
      meta: Object.freeze({override: true}),
      req: Object.freeze({
        headers: Object.freeze({'x-override': 'override'}),
        retry: Object.freeze({limit: 0})
      })
    });
    const original = structuredClone(overrides);
    const baseHeaders = {...base.req.headers};

    const merged = mergeOverrideOptions(base, overrides);

    expect(overrides).toEqual(original);
    expect(structuredClone(overrides)).toEqual(original);
    expect(merged.meta).toEqual({base: true, override: true});
    expect(merged.req.headers).toMatchObject({
      'x-base': 'base', 'x-override': 'override'
    });
    expect(merged.req.hooks?.beforeRequest).toContain(beforeRequest);
    expect(merged.req.hooks?.beforeRetry?.length).toBeGreaterThan(0);
    expect(merged.req.retry).toMatchObject({limit: 0});
    expect(base.concurrency).toBe(12);
    expect(base.meta).toEqual({base: true});
    expect(base.req.headers).toEqual(baseHeaders);
  });
});

describe('calculateFastDelay', function () {
  test('returns 0 when attemptCount exceeds limit', () => {
    const obj = makeRetryObject({attemptCount: 5, limit: 3});
    expect(calculateFastDelay(obj)).toBe(0);
    expect((obj.error as unknown as {retryLimitExceeded: boolean})
      .retryLimitExceeded).toBe(true);
  });

  test('sets retryLimitExceeded false within limit', () => {
    const obj = makeRetryObject({attemptCount: 1, limit: 3});
    calculateFastDelay(obj);
    expect((obj.error as unknown as {retryLimitExceeded: boolean})
      .retryLimitExceeded).toBe(false);
  });

  test('returns positive delay for retryable error', () => {
    const obj = makeRetryObject({attemptCount: 1});
    const delay = calculateFastDelay(obj);
    expect(delay).toBeGreaterThan(0);
  });

  test.each([0, 0.001, 0.004999])('keeps the first retry when jitter is %s', random => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(random);
    try {
      expect(calculateFastDelay(makeRetryObject({}))).toBe(1);
    } finally { spy.mockRestore(); }
  });

  test.each(['0', 'Thu, 01 Jan 1970 00:00:00 GMT'])(
    'keeps a retry due immediately for Retry-After %s', retryAfter => {
      const spy = jest.spyOn(Date, 'now').mockReturnValue(0);
      try {
        expect(calculateFastDelay(makeRetryObject({statusCode: 429,
          errorName: 'HTTPError', retryAfter}))).toBe(1);
      } finally { spy.mockRestore(); }
    });

  test('does not wrap a stale HTTP-date into a long future delay', () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 2, 14, 30));
    try {
      expect(calculateFastDelay(makeRetryObject({statusCode: 429,
        errorName: 'HTTPError', retryAfter: 'Thu, 01 Jan 1970 00:00:00 GMT'}))).toBe(1);
    } finally { spy.mockRestore(); }
  });

  test('caps a large server delay at the largest supported timer value', () => {
    expect(calculateFastDelay(makeRetryObject({statusCode: 429,
      errorName: 'HTTPError', retryAfter: '4294968'}))).toBe(2147483647);
  });

  test('429 with retry-after within maxRetryAfter uses retry-after', () => {
    const obj = makeRetryObject({
      attemptCount: 1,
      statusCode: 429,
      errorName: 'HTTPError',
      retryAfter: '30',
      maxRetryAfter: 60000,
    });
    const delay = calculateFastDelay(obj);
    // retryAfter=30 is parsed as 30 seconds = 30000ms, within 60000 max
    expect(delay).toBe(30000);
  });

  test('429 with retry-after exceeding maxRetryAfter ignores retry-after', () => {
    const obj = makeRetryObject({
      attemptCount: 1,
      statusCode: 429,
      errorName: 'HTTPError',
      retryAfter: '120',
      maxRetryAfter: 60000,
    });
    const delay = calculateFastDelay(obj);
    // retryAfter=120s=120000ms > maxRetryAfter=60000, should NOT use retryAfter
    expect(delay).toBeLessThan(120000);
  });

  test('429 with retry-after and no maxRetryAfter uses retry-after', () => {
    const obj = makeRetryObject({
      attemptCount: 1,
      statusCode: 429,
      errorName: 'HTTPError',
      retryAfter: '45',
    });
    const delay = calculateFastDelay(obj);
    expect(delay).toBe(45000);
  });

  test('returns 0 for non-retryable method', () => {
    const obj = makeRetryObject({attemptCount: 1, method: 'POST'});
    expect(calculateFastDelay(obj)).toBe(0);
  });
});

describe('configuration ownership', () => {
  test('allocates independent nested defaults and hook arrays', () => {
    const lifecycle = defaultLifeCycle();
    const first = defaultDownloadOptions({...lifecycle, localRoot: 'one'});
    const second = defaultDownloadOptions({...lifecycle, localRoot: 'two'});
    first.req.headers = {...first.req.headers, 'x-first': 'yes'};
    first.meta.custom = true;
    first.init.push(() => undefined);
    expect(second.req.headers).not.toHaveProperty('x-first');
    expect(second.meta).not.toHaveProperty('custom');
    expect(second.init).toHaveLength(lifecycle.init.length);
  });

  test('repeated option snapshots preserve hooks without accumulating merge history', () => {
    const hook = jest.fn<BeforeRequestHook>();
    let options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: 'out',
      req: {hooks: {beforeRequest: [hook]}, retry: {limit: 0}}});
    for (let index = 0; index < 1000; index++) {
      options = mergeOverrideOptions(options, {req: {headers: {'x-run': String(index)}}});
    }
    expect(Object.getPrototypeOf(options.req)).toBe(Object.prototype);
    expect(options.req).not.toHaveProperty('_init');
    expect(options.req.hooks?.beforeRequest).toEqual([hook]);
    expect(options.req.retry).toMatchObject({limit: 0});
    expect(options.req.headers?.['x-run']).toBe('999');
  });
});

test('compact request snapshots retain explicit defaults and changes from init hooks', () => {
  const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: 'output', req: {
    decompress: true,
    hooks: {init: [(_raw, normalized) => { normalized.http2 = true; }]}
  }});
  expect(options.req.decompress).toBe(true);
  expect(options.req.http2).toBe(true);
  const merged = mergeOverrideOptions(options, {req: {headers: {'x-probe': 'value'}}});
  expect(merged.req.http2).toBe(true);
  expect(merged.req.decompress).toBe(true);
  expect(merged.req.headers?.['x-probe']).toBe('value');
});

test('reusing normalized options detects nested mutations and reruns init hooks', () => {
  const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: 'output', req: {retry: {limit: 0}}});
  options.req.headers!['x-changed'] = 'yes';
  expect(mergeOverrideOptions(options).req.headers?.['x-changed']).toBe('yes');
  Reflect.set(options.req.retry!, 'limit', 'invalid');
  expect(() => mergeOverrideOptions(options)).toThrow();
  const init = jest.fn();
  const hooked = defaultDownloadOptions({...defaultLifeCycle(), localRoot: 'output', req: {hooks: {init: [init]}}});
  const before = init.mock.calls.length;
  mergeOverrideOptions(hooked);
  expect(init.mock.calls.length).toBeGreaterThan(before);
});
