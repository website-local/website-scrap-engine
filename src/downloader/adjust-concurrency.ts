import {performance} from 'node:perf_hooks';
import type {Logger} from '../logger/types.js';
import type {DownloaderWithMeta} from './types.js';

/** A pause/restart must not turn idle time into apparent server slowdown. */
export function resetAdjustment(downloader: DownloaderWithMeta): void {
  const {meta} = downloader;
  meta.lastPeriodTime = performance.now();
  meta.lastPeriodRate = undefined;
  meta.firstPeriodCount = 0;
  meta.lastPeriodCount = 0;
  meta.currentPeriodCount = 0;
  meta.lastPeriodTotalCount = downloader.downloadedCount;
}

/** Opt-in bounded additive increase / multiplicative decrease from completion rates. */
export function adjust(downloader: DownloaderWithMeta, logger?: Logger): void {
  const {meta, options} = downloader;
  if (meta.lastPeriodTime === undefined || downloader.downloadedCount < meta.lastPeriodTotalCount) {
    resetAdjustment(downloader);
    return;
  }
  const now = performance.now();
  const elapsed = now - meta.lastPeriodTime;
  if (elapsed <= 0) return;
  const count = downloader.downloadedCount - meta.lastPeriodTotalCount;
  const rate = count / elapsed;
  const previousRate = meta.lastPeriodRate;
  meta.lastPeriodCount = meta.currentPeriodCount;
  meta.currentPeriodCount = count;
  meta.lastPeriodTotalCount = downloader.downloadedCount;
  if (!meta.firstPeriodCount && count) meta.firstPeriodCount = count;
  meta.lastPeriodTime = now;
  meta.lastPeriodRate = undefined;
  // An empty/paused/unsaturated queue cannot tell us the effect of more load.
  if (!downloader.queueSize || downloader.queuePending < downloader.concurrency) return;
  meta.lastPeriodRate = rate;
  const maximum = options.maxConcurrency ?? Math.max(options.concurrency, options.minConcurrency ?? 1);
  const minimum = options.minConcurrency ?? Math.min(4, maximum);
  let concurrency = downloader.concurrency;
  if (rate === 0) concurrency = Math.floor(concurrency / 2);
  else if (previousRate !== undefined) {
    if (rate < previousRate * 0.8) concurrency = Math.floor(concurrency * 0.75);
    else if (rate >= previousRate * 0.95) ++concurrency;
  }
  downloader.concurrency = Math.min(maximum, Math.max(minimum, concurrency));
  logger?.info('system.adjustConcurrency', 'concurrency', downloader.concurrency, 'queue size:', downloader.queueSize,
    'completed per second:', rate * 1000);
}
