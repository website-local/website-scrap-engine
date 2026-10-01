import type {logLevels} from '../logger/logger-worker.js';
import type {LogType} from '../logger/types.js';
import type {WorkerMessage, WorkerMessageType, WORKER_PROTOCOL_VERSION} from './types.js';

export interface WorkerLog<T = unknown> {
  logType: LogType;
  level: typeof logLevels[number];
  content: T[];
}

export interface LogWorkerMessage<T = unknown> extends WorkerMessage<WorkerLog<T>> {
  type: WorkerMessageType.Log;
}

export interface WorkerTaskMessage<T> {
  readonly version: typeof WORKER_PROTOCOL_VERSION;
  readonly taskId: number;
  body: T;
}
