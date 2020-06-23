import {DownloadOptions} from '../options';
import PQueue from 'p-queue';

export interface DownloaderStats {
  firstPeriodCount: number;
  lastPeriodTotalCount: number;
  currentPeriodCount: number;
  lastPeriodCount: number;
}

export interface DownloaderWithMeta {
  readonly meta: DownloaderStats;
  readonly queue: PQueue;
  readonly options: DownloadOptions;

  getDownloadedCount() : number;
}

export class DownloaderMain implements DownloaderWithMeta {
  readonly queue: PQueue;
  readonly options: DownloadOptions;
  readonly meta: DownloaderStats = {
    currentPeriodCount: 0,
    firstPeriodCount: 0,
    lastPeriodCount: 0,
    lastPeriodTotalCount: 0
  };
  constructor(public pathToOptions: string) {
    this.options = require(pathToOptions);
    this.queue = new PQueue({concurrency: this.options.concurrency});
  }

  getDownloadedCount(): number {
    // TODO
    return 0;
  }
}
