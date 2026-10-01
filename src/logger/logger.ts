import {currentCrawlContext} from '../crawl-context.js';
import {isMainThread} from 'node:worker_threads';
import type {CategoryLogger, Logger, LogType} from './types.js';
import {createDefaultLogger} from './default-logger.js';
import {createWorkerCategoryLogger} from './logger-worker.js';

let _logger: Logger = createDefaultLogger();

export function setLogger(logger: Logger): void {
  _logger = logger;
}

export function getLogger(): Logger {
  return currentCrawlContext()?.logger ?? _logger;
}

function createCategoryProxy(type: LogType): CategoryLogger {
  if (!isMainThread) {
    return createWorkerCategoryLogger(type);
  }
  return {
    trace(...contents: unknown[]) { getLogger().trace(type, ...contents); },
    debug(...contents: unknown[]) { getLogger().debug(type, ...contents); },
    info(...contents: unknown[]) { getLogger().info(type, ...contents); },
    warn(...contents: unknown[]) { getLogger().warn(type, ...contents); },
    error(...contents: unknown[]) { getLogger().error(type, ...contents); },
    isTraceEnabled() { return getLogger().isTraceEnabled(); },
  };
}

export const notFound: CategoryLogger = createCategoryProxy('io.http.notFound');
export const retry: CategoryLogger = createCategoryProxy('io.http.retry');
export const mkdir: CategoryLogger = createCategoryProxy('io.disk.mkdir');
export const request: CategoryLogger = createCategoryProxy('io.http.request');
export const response: CategoryLogger = createCategoryProxy('io.http.response');
export const error: CategoryLogger = createCategoryProxy('system.error');
export const complete: CategoryLogger = createCategoryProxy('system.complete');
export const skip: CategoryLogger = createCategoryProxy('system.skip');
export const skipExternal: CategoryLogger = createCategoryProxy('system.skipExternal');
export const adjustConcurrency: CategoryLogger = createCategoryProxy('system.adjustConcurrency');
