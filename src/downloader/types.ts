import type {MessagePort} from 'node:worker_threads';
import type {DownloadOptions} from '../options.js';
import type {WireResource} from '../resource.js';

export interface DownloaderStats {
  firstPeriodCount: number;
  lastPeriodTotalCount: number;
  currentPeriodCount: number;
  lastPeriodCount: number;
  /** Allocated only when adaptive concurrency is enabled. */
  adjustmentTime?: number;
  adjustmentTotal?: number;
  adjustmentRate?: number;
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
  // workaround for typescript 4.1.2
  resolve: ((value?: T | PromiseLike<T>) => void) |
    ((value: T | PromiseLike<T>) => void) ;
  reject: (reason?: E) => void;
}

export interface PendingPromiseWithBody<R = unknown, E = unknown, B = unknown>
  extends PendingPromise<R, E> {
  taskId: number;
  body: B;
  workerId?: number;
  transferList?: Array<ArrayBuffer | MessagePort>;
}

export enum WorkerMessageType {
  Log,
  Complete
}

export interface WorkerMessage<T = unknown> {
  taskId: number;
  type: WorkerMessageType;
  body: T;
  error?: Error | unknown | void;
}

export interface DownloadWorkerMessage extends WorkerMessage<WireResource[]> {
  /**
   * Available if processed redirect url differs from url
   */
  redirectedUrl?: string;
}
