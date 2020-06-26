import {ResourceEncoding, ResourceType} from './resource';
import {ProcessingLifeCycle, RequestOptions} from './pipeline';
import {DownloaderWithMeta} from './downloader/main';

/**
 * Options which should not be changed at runtime, and safe for cloning
 */
export interface StaticDownloadOptions {
  /**
   * @see Resource.localRoot
   */
  localRoot: string;

  /**
   * Maximum recursive depth
   * @see Resource.depth
   */
  maxDepth: number;

  /**
   * Downloading concurrency
   */
  concurrency: number;

  /**
   * Resource default encoding by type.
   *
   * Encoding of a resource can be changed at
   * {@link ProcessingLifeCycle.processBeforeDownload}
   */
  encoding: Record<ResourceType, ResourceEncoding>;

  meta: Record<string, string | number | boolean> & {
    detectIncompleteHtml?: '</html>' | '</body>' | string;
  }
}

export interface DownloadOptions extends StaticDownloadOptions, ProcessingLifeCycle {
  req: RequestOptions;
  concurrency: number;
  initialUrl?: string[];
  /**
   * WorkerPool.coreSize = Math.min(
   * require('os').cpus().length - 2,
   * {@link concurrency},
   * {@link workerCount}
   * )
   */
  workerCount?: number;
  minConcurrency?: number;
  adjustConcurrencyPeriod?: number;
  adjustConcurrencyFunc?: (downloader: DownloaderWithMeta) => void;
}

export function mergeOverrideOptions(
  options: DownloadOptions,
  overrideOptions?: Partial<StaticDownloadOptions>): DownloadOptions {
  if (!overrideOptions) {
    return options;
  }
  const {meta} = options;
  Object.assign(options, overrideOptions);
  if (overrideOptions.meta) {
    Object.assign(meta, overrideOptions.meta);
  }
  return options;
}

