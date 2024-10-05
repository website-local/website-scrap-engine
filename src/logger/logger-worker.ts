import type {Logger} from 'log4js';
// https://github.com/jestjs/jest/issues/11563
import log4js from 'log4js';
import {parentPort} from 'node:worker_threads';
import type {LogWorkerMessage, WorkerLog} from '../downloader/worker-type.js';
import {WorkerMessageType} from '../downloader/types.js';

const getLogger = log4js.getLogger;

export const logLevels = [
  'trace', 'debug', 'info', 'warn', 'error', 'fatal', 'mark'
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
