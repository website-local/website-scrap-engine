import {logLevels} from '../logger/logger-worker';
import * as logger from '../logger/logger';
import {WorkerMessage, WorkerMessageType} from './types';

export interface WorkerLog<T = unknown> {
  logger: keyof typeof logger;
  level: typeof logLevels[number];
  content: T[];
}

export interface LogWorkerMessage<T = unknown> extends WorkerMessage<WorkerLog<T>> {
  type: WorkerMessageType.Log;
}

