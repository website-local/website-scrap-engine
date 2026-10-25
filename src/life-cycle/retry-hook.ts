import type {RequestError} from 'got';
import {TimeoutError} from 'got';
import type {Logger} from '../logger/types.js';

/** Take logs before retry */
export const beforeRetryHook = (
  error: RequestError,
  retryCount: number | undefined,
  logger?: Logger
) => {
  const options = error.options;
  if (!options || !logger) {
    return;
  }
  const url = String(options.url);
  const log = retryCount && retryCount > 1 ? logger.warn : logger.info;
  if (error instanceof TimeoutError || error.name === 'TimeoutError') {
    log.call(logger, 'io.http.retry', retryCount, url, error.name, error.code,
      error.message, (error as TimeoutError).event);
  } else {
    log.call(logger, 'io.http.retry', retryCount, url, error.name, error.code, error.message);
  }
};
