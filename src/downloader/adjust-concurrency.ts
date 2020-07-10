import {adjustConcurrency as logger} from '../logger/logger';
import {DownloaderWithMeta} from './types';

export function adjust(downloader: DownloaderWithMeta): void {
  const {meta} = downloader;
  if (!meta.firstPeriodCount) {
    meta.firstPeriodCount = downloader.downloadedCount;
    meta.lastPeriodTotalCount =
      meta.currentPeriodCount =
        meta.lastPeriodCount =
          meta.firstPeriodCount;
    return;
  }
  const total = downloader.downloadedCount;
  meta.lastPeriodCount = meta.currentPeriodCount;
  meta.currentPeriodCount = total - meta.lastPeriodTotalCount;
  meta.lastPeriodTotalCount = total;
  if (downloader.queueSize === 0) {
    return logger.info('Queue is empty, keep concurrency as ',
      downloader.concurrency, 'pending items: ', downloader.queuePending);
  }
  let concurrency = downloader.concurrency;
  if (meta.currentPeriodCount < 2) {
    concurrency += 8;
  } else if (meta.currentPeriodCount < meta.lastPeriodCount >> 1) {
    concurrency += 4;
  }
  if (meta.currentPeriodCount < meta.firstPeriodCount >> 2) {
    concurrency += 2;
  }

  if (meta.currentPeriodCount > meta.lastPeriodCount << 2) {
    concurrency -= 4;
  } else if (meta.currentPeriodCount > meta.lastPeriodCount << 1) {
    concurrency -= 2;
  } else if (meta.currentPeriodCount > meta.firstPeriodCount) {
    concurrency -= 2;
  }
  downloader.concurrency =
    Math.max(downloader.options.minConcurrency ?? 4, concurrency);
  logger.info('concurrency', downloader.concurrency,
    'queue size:', downloader.queueSize);
}
