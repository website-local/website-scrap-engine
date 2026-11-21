import {adjustConcurrency as logger} from '../logger/logger.js';
import type {DownloaderWithMeta} from './types.js';

/** A pause/restart must not turn idle time into apparent server slowdown. */
export function resetAdjustment(downloader: DownloaderWithMeta): void {
  const {meta} = downloader;
  meta.adjustmentTime = performance.now();
  meta.adjustmentTotal = downloader.downloadedCount;
  meta.adjustmentRate = undefined;
  meta.firstPeriodCount = 0;
  meta.lastPeriodCount = 0;
  meta.currentPeriodCount = 0;
  meta.lastPeriodTotalCount = downloader.downloadedCount;
}

/** Opt-in additive recovery and backoff, capped at configured concurrency. */
export function adjust(downloader: DownloaderWithMeta): void {
  const {meta, options} = downloader;
  const total = downloader.downloadedCount;
  if (meta.adjustmentTime === undefined || meta.adjustmentTotal === undefined ||
    total < meta.adjustmentTotal) {
    resetAdjustment(downloader);
    return;
  }
  const now = performance.now();
  const elapsed = now - meta.adjustmentTime;
  if (elapsed <= 0) return;
  const count = total - meta.adjustmentTotal;
  const rate = count / elapsed;
  const previousRate = meta.adjustmentRate;
  meta.lastPeriodCount = meta.currentPeriodCount;
  meta.currentPeriodCount = count;
  meta.lastPeriodTotalCount = total;
  if (!meta.firstPeriodCount && count) meta.firstPeriodCount = count;
  meta.adjustmentTime = now;
  meta.adjustmentTotal = total;
  meta.adjustmentRate = undefined;
  // An empty or unsaturated queue cannot tell us the effect of more load.
  if (!downloader.queueSize || downloader.queuePending < downloader.concurrency) return;
  meta.adjustmentRate = rate;
  const maximum = options.concurrency;
  const minimum = Math.min(options.minConcurrency ?? 4, maximum);
  let concurrency = downloader.concurrency;
  if (rate === 0) concurrency = Math.floor(concurrency / 2);
  else if (previousRate !== undefined) {
    if (rate < previousRate * 0.8) concurrency = Math.floor(concurrency * 0.75);
    else if (rate >= previousRate * 0.95) ++concurrency;
  }
  downloader.concurrency = Math.min(maximum, Math.max(minimum, concurrency));
  logger.info('concurrency', downloader.concurrency, 'queue size:', downloader.queueSize,
    'completed per second:', rate * 1000);
}
