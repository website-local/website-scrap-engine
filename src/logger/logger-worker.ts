import {parentPort} from 'node:worker_threads';
import type {CategoryLogger, Logger, LogType} from './types.js';
import {NativeUri} from '../uri.js';
import type {LogWorkerMessage} from '../downloader/worker-type.js';
import {WorkerMessageType} from '../downloader/types.js';

export const logLevels = [
  'trace', 'debug', 'info', 'warn', 'error'
] as const;

function send(type: LogType, level: typeof logLevels[number], content: unknown[]): void {
  for (let i = 0; i < content.length; i++) {
    const value = content[i];
    if (value instanceof URL || value instanceof NativeUri) content[i] = value.toString();
  }
  const message: LogWorkerMessage = {
    taskId: -1,
    type: WorkerMessageType.Log,
    body: {logType: type, level, content}
  };
  try {
    parentPort?.postMessage(message);
  } catch {
    // Non-cloneable diagnostic values must not turn a successful task into an error.
    for (let i = 0; i < content.length; i++) {
      try { content[i] = String(content[i]); } catch { content[i] = '[unprintable]'; }
    }
    try { parentPort?.postMessage(message); } catch { /* worker is closing */ }
  }
}

export function createWorkerLogger(): Logger {
  return {
    trace() { /* trace is disabled for relayed logs */ },
    debug(type, ...content) { send(type, 'debug', content); },
    info(type, ...content) { send(type, 'info', content); },
    warn(type, ...content) { send(type, 'warn', content); },
    error(type, ...content) { send(type, 'error', content); },
    isTraceEnabled() { return false; },
  };
}

export function createWorkerCategoryLogger(type: LogType): CategoryLogger {
  return {
    trace() { /* trace is disabled for relayed logs */ },
    debug(...content: unknown[]) { send(type, 'debug', content); },
    info(...content: unknown[]) { send(type, 'info', content); },
    warn(...content: unknown[]) { send(type, 'warn', content); },
    error(...content: unknown[]) { send(type, 'error', content); },
    isTraceEnabled() { return false; },
  };
}
