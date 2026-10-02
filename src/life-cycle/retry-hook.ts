import type {BeforeRetryHook, RequestError} from 'got';
import {TimeoutError} from 'got';
import * as logger from '../logger/logger.js';

/** Take logs before retry */
export const beforeRetryHook: BeforeRetryHook = (
  error: RequestError,
  retryCount: number | undefined
) => {
  const options = error.options;
  if (!options) {
    return;
  }
  const url = String(options.url);
  const log = retryCount && retryCount > 1 ? logger.retry.warn : logger.retry.info;
  if (error instanceof TimeoutError || error.name === 'TimeoutError') {
    log.call(logger.retry, retryCount, url, error.name, error.code,
      error.message, (error as TimeoutError).event);
  } else {
    log.call(logger.retry, retryCount, url, error.name, error.code, error.message);
  }
};
