import type {Transferable} from 'node:worker_threads';
import type {DownloadOptions} from '../options.js';
import type {RawResource} from '../resource.js';

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
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: E) => void;
}

export interface PendingPromiseWithBody<R = unknown, E = unknown, B = unknown>
  extends PendingPromise<R, E> {
  taskId: number;
  body: B;
  transferList?: Transferable[];
  workerId?: number;
}

export enum WorkerMessageType {
  Log,
  Complete
}

export enum WorkerControlMessageType {
  Ready = 'ready',
  Close = 'close',
  Closed = 'closed'
}

export interface WorkerMessage<T = unknown> {
  taskId: number;
  type: WorkerMessageType;
  body: T;
  error?: Error | unknown | void;
}

export interface WorkerControlMessage {
  type: WorkerControlMessageType;
}

export interface WorkerReadyMessage extends WorkerControlMessage {
  type: WorkerControlMessageType.Ready;
}

export interface WorkerCloseMessage extends WorkerControlMessage {
  type: WorkerControlMessageType.Close;
}

export interface WorkerClosedMessage extends WorkerControlMessage {
  type: WorkerControlMessageType.Closed;
}

export interface DownloadWorkerMessage extends WorkerMessage<RawResource[]> {
  /**
   * Available if processed redirect url differs from url
   */
  redirectedUrl?: string;
}
