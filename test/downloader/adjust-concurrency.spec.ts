import {afterEach, beforeEach, expect, jest, test} from '@jest/globals';
import {performance} from 'node:perf_hooks';
import {adjust, resetAdjustment} from '../../src/downloader/adjust-concurrency.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';

let now = 0;
beforeEach(() => {
  now = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => { jest.restoreAllMocks(); });

function crawler(maxConcurrency?: number) {
  const value = {options: defaultDownloadOptions({...defaultLifeCycle(),
    concurrency: 8, minConcurrency: 2, maxConcurrency}),
  concurrency: 8, queueSize: 100, queuePending: 8, downloadedCount: 0,
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

test('stalls reduce pressure even before the first completion and stop at the minimum', () => {
  const value = crawler(32);
  for (const expected of [4, 2, 2]) {
    sample(value, 0);
    expect(value.concurrency).toBe(expected);
  }
});

test('slowdown backs off while stable recovery grows one slot at a time', () => {
  const value = crawler(12);
  sample(value, 100);
  expect(value.concurrency).toBe(8);
  sample(value, 50);
  expect(value.concurrency).toBe(6);
  sample(value, 50);
  expect(value.concurrency).toBe(7);
  sample(value, 200);
  expect(value.concurrency).toBe(8);
  for (let i = 0; i < 10; i++) sample(value, 200);
  expect(value.concurrency).toBe(12);
});

test('elapsed time normalizes unequal observation periods', () => {
  const value = crawler(12);
  sample(value, 100);
  sample(value, 200, 2000);
  expect(value.concurrency).toBe(9);
  sample(value, 100, 2000);
  expect(value.concurrency).toBe(6);
});

test('the implicit ceiling is initial concurrency and counters do not overflow at 32 bits', () => {
  const value = crawler();
  sample(value, 2 ** 32);
  sample(value, 2 ** 32);
  expect(value.concurrency).toBe(8);
  expect(value.meta.currentPeriodCount).toBe(2 ** 32);
  expect(value.meta.lastPeriodTotalCount).toBe(2 ** 33);
});

test('idle, unsaturated, and restarted crawls discard stale throughput comparisons', () => {
  const value = crawler(12);
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

test('sampling is isolated per crawler and repeated calls at one time do nothing', () => {
  const first = crawler(12);
  const second = crawler(12);
  sample(first, 100);
  sample(first, 50);
  expect(first.concurrency).toBe(6);
  second.downloadedCount = 100;
  adjust(second);
  expect(second.concurrency).toBe(8);
  adjust(second);
  expect(second.concurrency).toBe(8);
});

test('invalid adjustment periods fail before starting timers', () => {
  for (const adjustConcurrencyPeriod of [0, -1, 0.5, NaN, Infinity, 2147483648]) {
    expect(() => defaultDownloadOptions({...defaultLifeCycle(), adjustConcurrencyPeriod}))
      .toThrow('adjustConcurrencyPeriod');
  }
});
