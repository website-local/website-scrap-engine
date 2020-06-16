import {configure, Log4js} from 'log4js';
import * as path from 'path';

export const configureLogger = (localRoot: string, subDir: string): Log4js =>
  configure({
    appenders: {
      'retry': {
        type: 'file',
        filename: path.join(localRoot, subDir, 'logs', 'retry.log')
      },
      'mkdir': {
        type: 'file',
        filename: path.join(localRoot, subDir, 'logs', 'mkdir.log')
      },
      'error': {
        type: 'file',
        filename: path.join(localRoot, subDir, 'logs', 'error.log')
      },
      'skip': {
        type: 'file',
        filename: path.join(localRoot, subDir, 'logs', 'skip.log')
      },
      '404': {
        type: 'file',
        filename: path.join(localRoot, subDir, 'logs', '404.log')
      },
      'complete': {
        type: 'file',
        filename: path.join(localRoot, subDir, 'logs', 'complete.log')
      },
      'request': {
        type: 'file',
        filename: path.join(localRoot, subDir, 'logs', 'request.log')
      },
      'response': {
        type: 'file',
        filename: path.join(localRoot, subDir, 'logs', 'response.log')
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
      'skip-external': {
        appenders: ['skip'],
        level: 'debug'
      },
      '404-not-found': {
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
      'adjust-concurrency': {
        appenders: ['stdout', 'complete'],
        level: 'debug'
      },
      'default': {
        appenders: ['stdout', 'complete'],
        level: 'debug'
      }
    }
  });
