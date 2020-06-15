import {createResource, Resource, ResourceBody, ResourceType} from "./resource";
import {Options as GotOptions} from "got/dist/source/core";
import {StaticDownloadOptions} from "./options";

declare type AsyncResult<T> = T | Promise<T>;

export interface LinkRedirectFunc {
  /**
   * redirect link before processing, or before child-resource creation
   * @param url
   * @param element source element
   * @param parent source resource
   * @param options
   * @return redirected url,
   * or void to skip processing and replacing to relative path
   */
  (url: string, element: Cheerio | null, parent: Resource,
   options: StaticDownloadOptions): AsyncResult<string | void>;
}

export interface DetectResourceTypeFunc {
  /**
   * Detect and change resource type
   * @param url
   * @param type last detected type
   * @param element source element
   * @param parent source resource
   * @param options
   * @return resource type, or void to discard resource
   */
  (url: string, type: ResourceType, element: Cheerio | null, parent: Resource,
   options: StaticDownloadOptions):
    AsyncResult<ResourceType | void>;
}

export interface ProcessResourceBeforeDownloadFunc {
  /**
   * Process and filter resource
   * @param res target resource
   * @param element source element
   * @param parent source resource
   * @param options
   * @return processed resource, or void to discard resource
   */
  (res: Resource, element: Cheerio | null, parent: Resource,
   options: StaticDownloadOptions):
    AsyncResult<Resource | void>;
}

export interface RequestOptions extends GotOptions {

}

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
   * @param res target resource
   * @param requestOptions passed to got
   * @param options
   * @return processed resource, or void to discard resource
   * @throws Error on download failures
   */
  (res: Resource, requestOptions: RequestOptions, options: StaticDownloadOptions):
    AsyncResult<Resource | void>;
}

export interface SubmitResourceFunc {
  /**
   * Submit resource to pipeline
   * @param res resource or array
   */
  (res: Resource | Resource[]): void;

}

export interface ProcessResourceAfterDownloadFunc {
  /**
   * Process resource after download, in worker thread
   * @param res resource received from main thread
   * @param submit function to submit resource to pipeline
   * @param options
   */
  (res: Resource & { body: ResourceBody }, submit: SubmitResourceFunc
   , options: StaticDownloadOptions): AsyncResult<Resource | void>;
}

export interface SaveToDiskFunc {
  /**
   * Save to disk
   * @param res
   * @param options
   * @return void for saved to disk, Resource for not saved.
   */
  (res: Resource & { body: ResourceBody }, options: StaticDownloadOptions):
    AsyncResult<Resource | void>;
}

export interface ProcessingLifeCycle {
  linkRedirect: LinkRedirectFunc[]
  detectLinkType: DetectResourceTypeFunc[];
  createResource: typeof createResource;
  /**
   * link in parent resource would be replaced after this
   */
  processBeforeDownload: ProcessResourceBeforeDownloadFunc[];
  /**
   * The only pipeline executed in main thread
   */
  download: DownloadResourceFunc[];
  processAfterDownload: ProcessResourceAfterDownloadFunc[];
  saveToDisk: SaveToDiskFunc[];
}

/**
 * Pipeline executor in worker thread
 */
export class PipelineExecuteWorker {
  constructor(public lifeCycle: ProcessingLifeCycle,
              public requestOptions: RequestOptions,
              public options: StaticDownloadOptions) {
  }
}
