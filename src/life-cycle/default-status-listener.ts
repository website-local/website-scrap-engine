import type {RawResource, Resource} from '../resource.js';
import type {ResourceStatus} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {PipelineExecutor} from './pipeline-executor.js';

export const defaultStatusListener = (
  res: Resource | RawResource,
  status: ResourceStatus,
  _options: StaticDownloadOptions,
  pipeline: PipelineExecutor
): void => {
  const logger = pipeline.logger;
  switch (status) {
  case 'processBeforeDownload':
    break;
  case 'createResource':
    break;
  case 'download':
    logger.debug('system.skip', 'discarded after download', res.url, res.rawUrl, res.refUrl);
    break;
  case 'processAfterDownload':
    logger.warn('system.skip', 'skipped downloaded resource', res.url, res.refUrl);
    break;
  case 'saveToDisk':
    logger.warn('system.skip', 'downloaded resource not saved', res.url, res.refUrl);
    break;
  case 'error':
    if (res.meta?.['errorCause']) {
      const err = res.meta['error'];
      const cause = res.meta['errorCause'] as string;
      if (err && (err as {name?: string}).name === 'HTTPError' &&
        (err as {response?: {statusCode?: number}})?.response?.statusCode === 404) {
        logger.error('io.http.notFound', res.url, res.downloadLink, res.refUrl);
      } else if (err &&
        (err as {name?: string}).name === 'LocalUrlMountNotFoundError' &&
        (err as {statusCode?: number})?.statusCode === 404) {
        logger.error('io.http.notFound', res.url, res.downloadLink, res.refUrl);
      } else if (err) {
        logger.error('system.error', cause, res.url, res.downloadLink, res.refUrl, err);
      } else {
        logger.error('system.error', cause, res.url, res.downloadLink, res.refUrl);
      }
    }
    break;
  case 'dispose':
    break;
  }
};
