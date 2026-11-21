import type {RawResource, Resource} from '../resource.js';
import type {ResourceStatus} from './types.js';
import {error, notFound, skip} from '../logger/logger.js';

export const defaultStatusListener = (
  res: Resource | RawResource,
  status: ResourceStatus
): void => {
  switch (status) {
  case 'processBeforeDownload':
    break;
  case 'createResource':
    break;
  case 'download':
    skip.debug('discarded after download', res.url, res.rawUrl, res.refUrl);
    break;
  case 'processAfterDownload':
    skip.warn('skipped downloaded resource', res.url, res.refUrl);
    break;
  case 'saveToDisk':
    skip.warn('downloaded resource not saved', res.url, res.refUrl);
    break;
  case 'error':
    if (res.meta?.['errorCause']) {
      const err = res.meta['error'];
      const cause = res.meta['errorCause'] as string;
      if (err && (err as {name?: string}).name === 'HTTPError' &&
        (err as {response?: {statusCode?: number}})?.response?.statusCode === 404) {
        notFound.error(res.url, res.downloadLink, res.refUrl);
      } else if (err &&
        (err as {name?: string}).name === 'LocalUrlMountNotFoundError' &&
        (err as {statusCode?: number})?.statusCode === 404) {
        notFound.error(res.url, res.downloadLink, res.refUrl);
      } else if (err) {
        error.error(cause, res.url, res.downloadLink, res.refUrl, err);
      } else {
        error.error(cause, res.url, res.downloadLink, res.refUrl);
      }
    }
    break;
  case 'dispose':
    break;
  }
};
