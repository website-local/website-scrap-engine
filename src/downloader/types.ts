import {DownloadOptions} from '../options';
import {RawResource} from '../resource';
import {MessagePort} from 'worker_threads';

export interface DownloaderStats {
  firstPeriodCount: number;
  lastPeriodTotalCount: number;
  currentPeriodCount: number;
  lastPeriodCount: number;
}

export interface DownloaderWithMeta {
  readonly meta: DownloaderStats;
  readonly options: DownloadOptions;

  /**
   * Concurrency of the queue.
   */
  concurrency: number;

  /**
   * Size of the queue.
   */
  readonly queueSize: number;

  /**
   * Number of pending promises.
   */
  readonly queuePending: number;

  /**
   * Number of downloaded resource.
   */
  readonly downloadedCount: number;
}

export interface PendingPromise<T = unknown, E = unknown> {
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: E) => void;
}

export interface PendingPromiseWithBody<R = unknown, E = unknown, B = unknown>
  extends PendingPromise<R, E> {
  body: B;
  transferList?: Array<ArrayBuffer | MessagePort>;
}

export enum WorkerMessageType {
  Log,
  Complete
}

export interface WorkerMessage<T = unknown> {
  type: WorkerMessageType;
  body: T;
  error?: Error | void;
}

export type DownloadWorkerMessage = WorkerMessage<RawResource[]>;
