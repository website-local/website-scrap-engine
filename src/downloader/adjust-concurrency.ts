import {performance} from 'node:perf_hooks';
import {adjustConcurrency as logger} from '../logger/logger.js';
import type {DownloaderWithMeta} from './types.js';

interface Sample {
  time: number;
  total: number;
  rate?: number;
}
const samples = new WeakMap<DownloaderWithMeta, Sample>();

/** A pause/restart must not turn idle time into apparent server slowdown. */
export function resetAdjustment(downloader: DownloaderWithMeta): void {
  samples.set(downloader, {time: performance.now(), total: downloader.downloadedCount});
  Object.assign(downloader.meta, {firstPeriodCount: 0, lastPeriodCount: 0,
    currentPeriodCount: 0, lastPeriodTotalCount: downloader.downloadedCount});
}

/** Opt-in bounded additive increase / multiplicative decrease from completion rates. */
export function adjust(downloader: DownloaderWithMeta): void {
  const previous = samples.get(downloader);
  if (!previous || downloader.downloadedCount < previous.total) {
    resetAdjustment(downloader);
    return;
  }
  const now = performance.now();
  const elapsed = now - previous.time;
  if (elapsed <= 0) return;
  const count = downloader.downloadedCount - previous.total;
  const rate = count / elapsed;
  const {meta, options} = downloader;
  meta.lastPeriodCount = meta.currentPeriodCount;
  meta.currentPeriodCount = count;
  meta.lastPeriodTotalCount = downloader.downloadedCount;
  if (!meta.firstPeriodCount && count) meta.firstPeriodCount = count;
  const next: Sample = {time: now, total: downloader.downloadedCount};
  samples.set(downloader, next);
  // An empty/paused/unsaturated queue cannot tell us the effect of more load.
  if (!downloader.queueSize || downloader.queuePending < downloader.concurrency) return;
  next.rate = rate;
  const maximum = options.maxConcurrency ?? Math.max(options.concurrency, options.minConcurrency ?? 1);
  const minimum = options.minConcurrency ?? Math.min(4, maximum);
  let concurrency = downloader.concurrency;
  if (rate === 0) concurrency = Math.floor(concurrency / 2);
  else if (previous.rate !== undefined) {
    if (rate < previous.rate * 0.8) concurrency = Math.floor(concurrency * 0.75);
    else if (rate >= previous.rate * 0.95) ++concurrency;
  }
  downloader.concurrency = Math.min(maximum, Math.max(minimum, concurrency));
  logger.info('concurrency', downloader.concurrency, 'queue size:', downloader.queueSize,
    'completed per second:', rate * 1000);
}
