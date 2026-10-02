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
  if (!error) {
    logger.retry.warn(retryCount, String(options.url));
    return;
  }
  const url = String(error.options.url);
  if (error instanceof TimeoutError || error.name === 'TimeoutError') {
    (retryCount && retryCount > 1 ? logger.retry.warn : logger.retry.info)
      .call(logger.retry, retryCount, url, error.name, error.code,
        error.message, (error as TimeoutError).event);
  } else {
    (retryCount && retryCount > 1 ? logger.retry.warn : logger.retry.info)
      .call(logger.retry, retryCount, url, error.name, error.code, error.message);
  }
};
