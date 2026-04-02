export type LogType =
  | 'io.http.request'
  | 'io.http.response'
  | 'io.http.notFound'
  | 'io.http.retry'
  | 'io.disk.mkdir'
  | 'system.skip'
  | 'system.skipExternal'
  | 'system.complete'
  | 'system.adjustConcurrency'
  | 'system.error'
  | `custom.${string}`;

export interface Logger {
  trace(type: LogType, ...contents: unknown[]): void;
  debug(type: LogType, ...contents: unknown[]): void;
  info(type: LogType, ...contents: unknown[]): void;
  warn(type: LogType, ...contents: unknown[]): void;
  error(type: LogType, ...contents: unknown[]): void;
  isTraceEnabled(): boolean;
}

/**
 * Logger proxy for a specific category.
 * Consumer code calls methods without a LogType argument;
 * the proxy prepends the appropriate LogType automatically.
 */
export interface CategoryLogger {
  trace(...contents: unknown[]): void;
  debug(...contents: unknown[]): void;
  info(...contents: unknown[]): void;
  warn(...contents: unknown[]): void;
  error(...contents: unknown[]): void;
  isTraceEnabled(): boolean;
}
