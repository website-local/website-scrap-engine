import type {logLevels} from '../logger/logger-worker.js';
import type {LogType} from '../logger/types.js';
import type {WorkerMessage, WorkerMessageType} from './types.js';

export interface WorkerLog<T = unknown> {
  logType: LogType;
  level: typeof logLevels[number];
  content: T[];
}

export interface LogWorkerMessage<T = unknown> extends WorkerMessage<WorkerLog<T>> {
  type: WorkerMessageType.Log;
}

export interface WorkerTaskMessage<T> {
  readonly taskId: number;
  body: T;
}
