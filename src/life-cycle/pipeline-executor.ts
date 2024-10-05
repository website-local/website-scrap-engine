import type {Resource, ResourceEncoding, ResourceType} from '../resource.js';
import type {StaticDownloadOptions} from '../options.js';
import type {
  AsyncResult,
  DownloadResource,
  RequestOptions,
  SubmitResourceFunc
} from './types.js';
import type {Cheerio} from '../types.js';
import type {DownloaderWithMeta} from '../downloader/types.js';
import type {WorkerInfo} from '../downloader/worker-pool.js';

export interface PipelineExecutor {
  /**
   * @see InitLifeCycleFunc
   */
  init(
    pipeline: PipelineExecutor,
    downloader?: DownloaderWithMeta
  ): AsyncResult<void>;

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
    encoding?: ResourceEncoding,
    refSavePath?: string,
    refType?: ResourceType
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
   * Process resource after download, maybe in worker thread
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

  /**
   * @see DisposeLifeCycle
   */
  dispose(
    pipeline: PipelineExecutor,
    downloader: DownloaderWithMeta,
    workerInfo?: WorkerInfo,
    workerExitCode?: number
  ): AsyncResult<void>;

}
