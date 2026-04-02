import type {Logger} from './types.js';

export function createDefaultLogger(): Logger {
  return {
    trace() { /* no-op */ },
    debug(type, ...contents) { console.debug(`[${type}]`, ...contents); },
    info(type, ...contents) { console.info(`[${type}]`, ...contents); },
    warn(type, ...contents) { console.warn(`[${type}]`, ...contents); },
    error(type, ...contents) { console.error(`[${type}]`, ...contents); },
    isTraceEnabled() { return false; },
  };
}
