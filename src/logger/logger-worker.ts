import {getLogger, Logger} from 'log4js';
import {parentPort} from 'worker_threads';
import type {LogWorkerMessage, WorkerLog} from '../downloader/worker-type';
import {WorkerMessageType} from '../downloader/types';

export const logLevels = [
  'log', 'trace', 'debug', 'info', 'warn', 'error', 'fatal', 'mark'
] as const;

export function getWorkerLogger(category: WorkerLog['logger']): Logger {
  const logger: Logger = getLogger(category);
  logLevels.forEach((level: typeof logLevels[number]) => {
    logger[level] = <T>(...content: T[]) => {
      const msg: LogWorkerMessage<T> = {
        taskId: -1,
        type: WorkerMessageType.Log,
        body: {
          level,
          logger: category,
          content
        }
      };
      parentPort?.postMessage(msg);
    };
  });
  return logger;
}
