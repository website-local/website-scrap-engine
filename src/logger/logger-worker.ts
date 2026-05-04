import type {CategoryLogger, LogType} from './types.js';
import type {LogWorkerMessage} from '../downloader/worker-type.js';
import {WorkerMessageType} from '../downloader/types.js';
import {getWorkerChannels} from '../downloader/worker-channel.js';

export const logLevels = [
  'trace', 'debug', 'info', 'warn', 'error'
] as const;

export function createWorkerCategoryLogger(type: LogType): CategoryLogger {
  const {logPort} = getWorkerChannels();

  function send<T>(level: typeof logLevels[number], content: T[]): void {
    const msg: LogWorkerMessage<T> = {
      taskId: -1,
      type: WorkerMessageType.Log,
      body: {
        logType: type,
        level,
        content
      }
    };
    logPort.postMessage(msg);
  }

  return {
    trace(...content: unknown[]) { send('trace', content); },
    debug(...content: unknown[]) { send('debug', content); },
    info(...content: unknown[]) { send('info', content); },
    warn(...content: unknown[]) { send('warn', content); },
    error(...content: unknown[]) { send('error', content); },
    isTraceEnabled() { return false; },
  };
}
