import type {CategoryLogger, Logger, LogType} from './types.js';
import type {LogWorkerMessage} from '../downloader/worker-type.js';
import {WorkerMessageType, WORKER_PROTOCOL_VERSION} from '../downloader/types.js';
import {getWorkerChannels} from '../downloader/worker-channel.js';

export const logLevels = [
  'trace', 'debug', 'info', 'warn', 'error'
] as const;

export function createWorkerCategoryLogger(type: LogType): CategoryLogger {
  const {logPort} = getWorkerChannels();

  function send<T>(level: typeof logLevels[number], content: T[]): void {
    const msg: LogWorkerMessage<T> = {
      version: WORKER_PROTOCOL_VERSION,
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

/** Installed by the worker entry point; main-thread logging has no worker imports. */
export function createWorkerLogger(): Logger {
  const {logPort} = getWorkerChannels();
  const send = (level: typeof logLevels[number], logType: LogType, content: unknown[]) => {
    logPort.postMessage({version: WORKER_PROTOCOL_VERSION, taskId: -1,
      type: WorkerMessageType.Log, body: {level, logType, content}});
  };
  return {
    trace(type, ...content) { send('trace', type, content); },
    debug(type, ...content) { send('debug', type, content); },
    info(type, ...content) { send('info', type, content); },
    warn(type, ...content) { send('warn', type, content); },
    error(type, ...content) { send('error', type, content); },
    isTraceEnabled() { return false; }
  };
}
