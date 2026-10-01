import type {Transferable, Worker} from 'node:worker_threads';
import type {DownloadOptions} from '../options.js';
import type {WireResource} from '../resource.js';

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
  onDispatched?: (worker: Worker) => void;
}

export enum WorkerMessageType {
  Log,
  Complete
}

export const WORKER_PROTOCOL_VERSION = 1 as const;

export enum WorkerControlMessageType {
  Ready = 'ready',
  Failed = 'failed',
  Close = 'close',
  Cancel = 'cancel',
  Closed = 'closed'
}

export interface WorkerMessage<T = unknown> {
  version: typeof WORKER_PROTOCOL_VERSION;
  taskId: number;
  type: WorkerMessageType;
  body: T;
  error?: Error | unknown | void;
}

export interface WorkerControlMessage {
  version: typeof WORKER_PROTOCOL_VERSION;
  type: WorkerControlMessageType;
  error?: string;
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

export interface DownloadWorkerMessage extends WorkerMessage<WireResource[]> {
  /** Built-in workers report confirmed publications and save-policy skips. */
  progress?: {publishedFiles: number; skipped: boolean};
  /**
   * Available if processed redirect url differs from url
   */
  redirectedUrl?: string;
}

/** Last attempt for one canonical admission URL; never retains bodies or DOMs. */
export interface ResourceOutcome {
  readonly status: 'queued' | 'running' | 'saved' | 'processed' | 'skipped' | 'failed' | 'cancelled';
  readonly attempt: number;
  readonly url: string;
  /** A body was acquired, including when later processing failed. */
  readonly downloaded: boolean;
  readonly publishedFiles: number;
}
