import {afterEach, beforeEach, expect, jest, test} from '@jest/globals';
import {adjust, resetAdjustment} from '../../src/downloader/adjust-concurrency.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';

let now = 0;
beforeEach(() => {
  now = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => { jest.restoreAllMocks(); });

function crawler(concurrency = 8, minConcurrency = 2) {
  const value = {options: defaultDownloadOptions({...defaultLifeCycle(), concurrency, minConcurrency}),
    concurrency, queueSize: 100, queuePending: concurrency, downloadedCount: 0,
    meta: {firstPeriodCount: 0, lastPeriodCount: 0, currentPeriodCount: 0, lastPeriodTotalCount: 0}};
  resetAdjustment(value);
  return value;
}

function sample(value: ReturnType<typeof crawler>, completed: number, elapsed = 1000) {
  now += elapsed;
  value.downloadedCount += completed;
  value.queuePending = value.concurrency;
  adjust(value);
}

test('stalls back off before the first completion and stop at the minimum', () => {
  const value = crawler();
  for (const expected of [4, 2, 2]) {
    sample(value, 0);
    expect(value.concurrency).toBe(expected);
  }
});

test('slowdown backs off while stable recovery stops at configured concurrency', () => {
  const value = crawler();
  sample(value, 100);
  expect(value.concurrency).toBe(8);
  sample(value, 50);
  expect(value.concurrency).toBe(6);
  sample(value, 50);
  expect(value.concurrency).toBe(7);
  for (let i = 0; i < 10; i++) sample(value, 50);
  expect(value.concurrency).toBe(8);
  const lowerCeiling = crawler(1, 4);
  sample(lowerCeiling, 0);
  expect(lowerCeiling.concurrency).toBe(1);
});

test('elapsed time normalizes unequal periods and large counters do not overflow', () => {
  const value = crawler();
  sample(value, 100);
  sample(value, 200, 2000);
  expect(value.concurrency).toBe(8);
  sample(value, 100, 2000);
  expect(value.concurrency).toBe(6);
  sample(value, 2 ** 32);
  sample(value, 2 ** 32);
  expect(value.concurrency).toBe(8);
  expect(value.meta.currentPeriodCount).toBe(2 ** 32);
  expect(value.meta.lastPeriodTotalCount).toBe(2 ** 33 + 400);
});

test('idle, unsaturated, and restarted crawls discard stale throughput comparisons', () => {
  const value = crawler();
  sample(value, 100);
  value.queueSize = 0;
  sample(value, 0);
  expect(value.concurrency).toBe(8);
  value.queueSize = 100;
  sample(value, 10);
  expect(value.concurrency).toBe(8);
  now += 1000;
  value.queuePending = 0;
  adjust(value);
  expect(value.concurrency).toBe(8);
  now += 60000;
  resetAdjustment(value);
  sample(value, 10);
  expect(value.concurrency).toBe(8);
});

test('samples are isolated and repeated times or reset counters do not create false stalls', () => {
  const first = crawler();
  const second = crawler();
  sample(first, 100);
  sample(first, 50);
  expect(first.concurrency).toBe(6);
  second.downloadedCount = 100;
  adjust(second);
  expect(second.concurrency).toBe(8);
  adjust(second);
  expect(second.concurrency).toBe(8);
  first.downloadedCount = 0;
  now += 1000;
  adjust(first);
  expect(first.concurrency).toBe(6);
  expect(first.meta.lastPeriodTotalCount).toBe(0);
});
