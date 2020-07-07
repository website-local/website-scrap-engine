import {Resource, ResourceEncoding, ResourceType} from '../resource';
import {StaticDownloadOptions} from '../options';
import {
  AsyncResult,
  DownloadResource,
  RequestOptions,
  SubmitResourceFunc
} from './types';

export interface PipelineExecutor {
  /**
   * Process
   * {@link .linkRedirect}
   * {@link .detectResourceType}
   * {@link .createResource}
   * {@link .processBeforeDownload}
   * in a single call
   */
  createAndProcessResource(
    rawUrl: string,
    defaultType: ResourceType,
    depth: number | void | null,
    element: Cheerio | null,
    parent: Resource
  ): AsyncResult<Resource | void>;

  linkRedirect(
    url: string,
    element: Cheerio | null,
    parent: Resource | null
  ): AsyncResult<string | void>;

  detectResourceType(
    url: string,
    type: ResourceType,
    element: Cheerio | null,
    parent: Resource | null
  ): AsyncResult<ResourceType | void>;

  createResource(
    type: ResourceType,
    depth: number,
    url: string,
    refUrl: string,
    localRoot?: string,
    encoding?: ResourceEncoding
  ): AsyncResult<Resource>;

  processBeforeDownload(
    res: Resource,
    element: Cheerio | null,
    parent: Resource | null,
    options?: StaticDownloadOptions
  ): AsyncResult<Resource | void>;

  download(
    res: Resource,
    requestOptions?: RequestOptions,
    options?: StaticDownloadOptions
  ): AsyncResult<DownloadResource | void>;

  /**
   * Process resource after download, in worker thread
   * @param res resource received from main thread
   * @param submit function to submit resource to pipeline
   * @param options
   */
  processAfterDownload(
    res: DownloadResource,
    submit: SubmitResourceFunc,
    options?: StaticDownloadOptions
  ): AsyncResult<DownloadResource | void>;

  saveToDisk(
    res: DownloadResource,
    options?: StaticDownloadOptions
  ): AsyncResult<DownloadResource | void>;
}
