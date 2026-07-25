import {describe, expect, test} from '@jest/globals';
// noinspection ES6PreferShortImport
import {
  downloadStreamingResource,
  isBytesAccepted,
  isSameRangeStart,
  shouldWaitForRequestError
} from '../../src/life-cycle/download-streaming-resource.js';
import type {Resource} from '../../src/resource.js';
import {ResourceType} from '../../src/resource.js';
import type {RequestOptions} from '../../src/life-cycle/types.js';
import type {StaticDownloadOptions} from '../../src/options.js';

describe('isBytesAccepted', function () {
  test('returns false for undefined', () => {
    expect(isBytesAccepted(undefined)).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isBytesAccepted('')).toBe(false);
  });

  test('returns true for bytes', () => {
    expect(isBytesAccepted('bytes')).toBe(true);
  });

  test('returns false for none', () => {
    expect(isBytesAccepted('none')).toBe(false);
  });

  test('returns true for comma-separated with bytes', () => {
    expect(isBytesAccepted('none,bytes')).toBe(true);
  });

  test('returns false for comma-separated without bytes', () => {
    expect(isBytesAccepted('none,other')).toBe(false);
  });
});

describe('isSameRangeStart', function () {
  test('returns false for undefined', () => {
    expect(isSameRangeStart(0, undefined)).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isSameRangeStart(0, '')).toBe(false);
  });

  test('returns true for matching range start', () => {
    expect(isSameRangeStart(100, 'bytes 100-200/300')).toBe(true);
  });

  test('returns false for non-matching range start', () => {
    expect(isSameRangeStart(50, 'bytes 100-200/300')).toBe(false);
  });

  test('returns true for range start 0', () => {
    expect(isSameRangeStart(0, 'bytes 0-200/300')).toBe(true);
  });

  test('returns false for missing space separator', () => {
    expect(isSameRangeStart(0, 'bytes')).toBe(false);
  });
});

describe('shouldWaitForRequestError', function () {
  test('returns true for request-originated stream failures', () => {
    expect(shouldWaitForRequestError({name: 'RequestError'})).toBe(true);
    expect(shouldWaitForRequestError({name: 'TimeoutError'})).toBe(true);
  });

  test('returns false for destination write failures', () => {
    const err = Object.assign(new Error('no space left on device'), {
      code: 'ENOSPC',
      name: 'Error'
    });

    expect(shouldWaitForRequestError(err)).toBe(false);
  });
});

describe('downloadStreamingResource', function () {
  // A non-http downloadLink (e.g. file://) must not be handed to got.stream();
  // it should fall through unchanged to the next (local) download handler.
  test('falls through for non-http downloadLink', async () => {
    const res = {
      type: ResourceType.StreamingBinary,
      downloadLink: 'file:///tmp/does-not-matter.bin',
      createTimestamp: Date.now()
    } as unknown as Resource;
    const result = await downloadStreamingResource(
      res, {} as RequestOptions, {} as StaticDownloadOptions);
    // returned verbatim, no download timestamps set (got.stream not invoked)
    expect(result).toBe(res);
    expect(res.downloadStartTimestamp).toBeUndefined();
  });
});
