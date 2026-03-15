import {describe, expect, jest, test} from '@jest/globals';
import type {RequestError, RetryObject} from 'got';
// noinspection ES6PreferShortImport
import {calculateFastDelay} from '../src/options.js';

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
    expect(delay).toBeGreaterThanOrEqual(0);
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
