import {adjustConcurrency as logger} from '../logger';
import {DownloaderWithMeta} from './main';

const adjust = (downloader: DownloaderWithMeta) => {
  const {meta} = downloader;
  if (!meta.firstPeriodCount) {
    meta.firstPeriodCount = downloader.getDownloadedCount();
    meta.lastPeriodTotalCount =
      meta.currentPeriodCount =
        meta.lastPeriodCount =
          meta.firstPeriodCount;
    return;
  }
  const total = downloader.getDownloadedCount();
  meta.lastPeriodCount = meta.currentPeriodCount;
  meta.currentPeriodCount = total - meta.lastPeriodTotalCount;
  meta.lastPeriodTotalCount = total;
  if (downloader.queue.size === 0) {
    return logger.info('Queue is empty, keep concurrency as ',
      downloader.queue.concurrency, 'pending items: ', downloader.queue.pending);
  }
  let concurrency = downloader.queue.concurrency;
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
  downloader.queue.concurrency =
    Math.max(downloader.options.minConcurrency ?? 4, concurrency);
  logger.info('concurrency', downloader.queue.concurrency,
    'queue size:', downloader.queue.size);
};

module.exports = adjust;
