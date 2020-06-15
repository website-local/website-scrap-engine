import {ResourceEncoding, ResourceType} from "./resource";
import {ProcessingLifeCycle, RequestOptions} from "./pipeline";

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
  encoding: Record<ResourceType, ResourceEncoding | string>;

  meta: Record<string, string | number | boolean> & {
    detectIncompleteHtml?: '</html>' | '</body>' | string;
    adjustConcurrencyPeriod: number;
  }
}

export interface DownloadOptions extends StaticDownloadOptions, ProcessingLifeCycle {
  req: RequestOptions;
}

