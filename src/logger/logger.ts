import type {Logger} from 'log4js';
import {getLogger as getMainLogger} from 'log4js';
import {isMainThread} from 'worker_threads';
import {getWorkerLogger} from './logger-worker.js';

const getLogger: typeof getWorkerLogger =
  isMainThread ? getMainLogger : getWorkerLogger;

export const notFound: Logger = getLogger('notFound');
export const retry: Logger = getLogger('retry');
export const mkdir: Logger = getLogger('mkdir');
export const request: Logger = getLogger('request');
export const response: Logger = getLogger('response');
export const error: Logger = getLogger('error');
export const complete: Logger = getLogger('complete');
export const skip: Logger = getLogger('skip');
export const skipExternal: Logger = getLogger('skipExternal');
export const adjustConcurrency: Logger = getLogger('adjustConcurrency');
