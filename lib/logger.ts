import {getLogger, Logger} from 'log4js';

export const notFound: Logger = getLogger('404-not-found');
export const retry: Logger = getLogger('retry');
export const mkdir: Logger = getLogger('mkdir');
export const request: Logger = getLogger('request');
export const response: Logger = getLogger('response');
export const error: Logger = getLogger('error');
export const complete: Logger = getLogger('complete');
export const skip: Logger = getLogger('skip');
export const adjustConcurrency: Logger = getLogger('adjust-concurrency');
