import {MessagePort} from 'worker_threads';
import {logLevels} from '../logger/logger-worker';
import * as logger from '../logger/logger';
import {RawResource} from '../resource';

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

export interface WorkerLog<T = unknown> {
  logger: keyof typeof logger;
  level: typeof logLevels[number];
  content: T[];
}

export interface LogWorkerMessage<T = unknown> extends WorkerMessage<WorkerLog<T>> {
  type: WorkerMessageType.Log;
}

export type DownloadWorkerMessage = WorkerMessage<RawResource[]>;
