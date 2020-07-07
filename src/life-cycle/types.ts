import {
  createResource,
  Resource,
  ResourceBody,
  ResourceType
} from '../resource';
import {Options as GotOptions} from 'got/dist/source/as-promise';
import {StaticDownloadOptions} from '../options';
import {PipelineExecutor} from './pipeline-executor';

export type AsyncResult<T> = T | Promise<T>;

export interface LinkRedirectFunc {
  /**
   * redirect link before processing, or before child-resource creation
   * @see PipelineExecutor.linkRedirect
   * @param url
   * @param element source element
   * @param parent source resource, null for initial resource
   * @param options
   * @param pipeline
   * @return redirected url,
   * or void to skip processing and replacing to relative path
   */
  (url: string, element: Cheerio | null, parent: Resource | null,
   options: StaticDownloadOptions,
   pipeline: PipelineExecutor): AsyncResult<string | void>;
}

export interface DetectResourceTypeFunc {
  /**
   * Detect and change resource type
   * @see PipelineExecutor.detectResourceType
   * @param url
   * @param type last detected type
   * @param element source element
   * @param parent source resource, null for initial resource
   * @param options
   * @param pipeline
   * @return resource type, or void to discard resource
   */
  (url: string, type: ResourceType, element: Cheerio | null,
   parent: Resource | null,
   options: StaticDownloadOptions,
   pipeline: PipelineExecutor): AsyncResult<ResourceType | void>;
}

export interface ProcessResourceBeforeDownloadFunc {
  /**
   * Process and filter resource
   * @see PipelineExecutor.processBeforeDownload
   * @param res target resource
   * @param element source element
   * @param parent source resource, null for initial resource
   * @param options
   * @param pipeline
   * @return processed resource, or void to discard resource
   */
  (res: Resource, element: Cheerio | null,
   parent: Resource | null,
   options: StaticDownloadOptions,
   pipeline: PipelineExecutor): AsyncResult<Resource | void>;
}

export type RequestOptions = GotOptions

/**
 * Process and filter resource,
 * resource should only be downloaded once,
 * downloaded resource would not continue pipeline.
 *
 * Downloaded resource should have {@link Resource.body}
 * to be treated as downloaded, resource
 * which passed the download pipeline without body is discarded.
 *
 * Pure-binary resource, which should never create child resource from,
 * can be saved to disk at here and filtered out.
 */
export interface DownloadResourceFunc {
  /**
   * @see PipelineExecutor.download
   * @param res target resource
   * @param requestOptions passed to got
   * @param options
   * @param pipeline
   * @return processed resource, or void to discard resource
   * @throws Error on download failures
   */
  (res: Resource, requestOptions: RequestOptions, options: StaticDownloadOptions,
   pipeline: PipelineExecutor): AsyncResult<DownloadResource | Resource | void>;
}

export interface SubmitResourceFunc {
  /**
   * Submit resource to pipeline
   * @param res resource or array
   */
  (res: Resource | Resource[]): void;

}

export interface DownloadResource extends Resource {
  body: ResourceBody;
}

export interface ProcessResourceAfterDownloadFunc {
  /**
   * Process resource after download, in worker thread
   * @see PipelineExecutor.processAfterDownload
   * @param res resource received from main thread
   * @param submit function to submit resource to pipeline
   * @param options
   * @param pipeline
   */
  (res: DownloadResource, submit: SubmitResourceFunc,
   options: StaticDownloadOptions,
   pipeline: PipelineExecutor): AsyncResult<DownloadResource | void>;
}

export interface SaveToDiskFunc {
  /**
   * Save to disk
   * @see PipelineExecutor.saveToDisk
   * @param res
   * @param options
   * @param pipeline
   * @return void for saved to disk, Resource for not saved.
   */
  (res: DownloadResource, options: StaticDownloadOptions,
   pipeline: PipelineExecutor): AsyncResult<DownloadResource | void>;
}

export interface ProcessingLifeCycle {
  linkRedirect: LinkRedirectFunc[]
  detectResourceType: DetectResourceTypeFunc[];
  createResource: typeof createResource;
  /**
   * link in parent resource would be replaced after this
   */
  processBeforeDownload: ProcessResourceBeforeDownloadFunc[];
  /**
   * The only pipeline executed in main thread for multi-thread downloader
   */
  download: DownloadResourceFunc[];
  processAfterDownload: ProcessResourceAfterDownloadFunc[];
  saveToDisk: SaveToDiskFunc[];
}

