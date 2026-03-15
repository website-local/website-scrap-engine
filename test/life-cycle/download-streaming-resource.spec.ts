import {describe, expect, test} from '@jest/globals';
// noinspection ES6PreferShortImport
import {
  isBytesAccepted,
  isSameRangeStart
} from '../../src/life-cycle/download-streaming-resource.js';

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
