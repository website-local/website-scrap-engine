import * as path from 'node:path';
import log4js from 'log4js';
import type {Logger, LogType} from './types.js';

const typeToCategory: Partial<Record<LogType, string>> = {
  'io.http.request': 'request',
  'io.http.response': 'response',
  'io.http.notFound': 'notFound',
  'io.http.retry': 'retry',
  'io.disk.mkdir': 'mkdir',
  'system.skip': 'skip',
  'system.skipExternal': 'skipExternal',
  'system.complete': 'complete',
  'system.adjustConcurrency': 'adjustConcurrency',
  'system.error': 'error',
};

export function createLog4jsLogger(
  localRoot: string,
  logSubDir?: string
): Logger {
  const logDir = path.join(localRoot, logSubDir || '', 'logs');
  log4js.configure({
    appenders: {
      'retry': {
        type: 'file',
        filename: path.join(logDir, 'retry.log')
      },
      'mkdir': {
        type: 'file',
        filename: path.join(logDir, 'mkdir.log')
      },
      'error': {
        type: 'file',
        filename: path.join(logDir, 'error.log')
      },
      'skip': {
        type: 'file',
        filename: path.join(logDir, 'skip.log')
      },
      '404': {
        type: 'file',
        filename: path.join(logDir, '404.log')
      },
      'complete': {
        type: 'file',
        filename: path.join(logDir, 'complete.log')
      },
      'request': {
        type: 'file',
        filename: path.join(logDir, 'request.log')
      },
      'response': {
        type: 'file',
        filename: path.join(logDir, 'response.log')
      },
      'stdout': {
        type: 'stdout'
      },
      'stderr': {
        type: 'stderr'
      }
    },
    categories: {
      'retry': {
        appenders: ['stdout', 'retry'],
        level: 'debug'
      },
      'mkdir': {
        appenders: ['mkdir'],
        level: 'debug'
      },
      'error': {
        appenders: ['stderr', 'error'],
        level: 'debug'
      },
      'skip': {
        appenders: ['stdout', 'skip'],
        level: 'debug'
      },
      'skipExternal': {
        appenders: ['skip'],
        level: 'debug'
      },
      'notFound': {
        appenders: ['404'],
        level: 'debug'
      },
      'complete': {
        appenders: ['complete'],
        level: 'debug'
      },
      'request': {
        appenders: ['request'],
        level: 'debug'
      },
      'response': {
        appenders: ['response'],
        level: 'debug'
      },
      'adjustConcurrency': {
        appenders: ['stdout', 'complete'],
        level: 'debug'
      },
      'default': {
        appenders: ['stdout', 'complete'],
        level: 'debug'
      }
    }
  });

  const loggers = new Map<string, log4js.Logger>();
  const getOrCreate = (category: string): log4js.Logger => {
    let l = loggers.get(category);
    if (!l) {
      l = log4js.getLogger(category);
      loggers.set(category, l);
    }
    return l;
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const spread = (contents: unknown[]): [any, ...any[]] =>
    contents as [any, ...any[]];
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    trace(type, ...contents) {
      getOrCreate(typeToCategory[type] ?? 'default').trace(...spread(contents));
    },
    debug(type, ...contents) {
      getOrCreate(typeToCategory[type] ?? 'default').debug(...spread(contents));
    },
    info(type, ...contents) {
      getOrCreate(typeToCategory[type] ?? 'default').info(...spread(contents));
    },
    warn(type, ...contents) {
      getOrCreate(typeToCategory[type] ?? 'default').warn(...spread(contents));
    },
    error(type, ...contents) {
      getOrCreate(typeToCategory[type] ?? 'default').error(...spread(contents));
    },
    isTraceEnabled() {
      return log4js.getLogger().isTraceEnabled();
    },
  };
}
