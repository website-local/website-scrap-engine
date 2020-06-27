import {
  createResource,
  Resource,
  ResourceBody,
  ResourceEncoding,
  ResourceType
} from './resource';
import {Options as GotOptions} from 'got/dist/source/as-promise';
import {StaticDownloadOptions} from './options';

declare type AsyncResult<T> = T | Promise<T>;

export interface LinkRedirectFunc {
  /**
   * redirect link before processing, or before child-resource creation
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
   * The only pipeline executed in main thread
   */
  download: DownloadResourceFunc[];
  processAfterDownload: ProcessResourceAfterDownloadFunc[];
  saveToDisk: SaveToDiskFunc[];
}

/**
 * Pipeline executor
 */
export class PipelineExecutor {
  constructor(public lifeCycle: ProcessingLifeCycle,
              public requestOptions: RequestOptions,
              public options: StaticDownloadOptions) {
  }

  async linkRedirect(url: string,
    element: Cheerio | null,
    parent: Resource | null): Promise<string | void> {
    let redirectedUrl: string | void = url;
    for (const linkRedirectFunc of this.lifeCycle.linkRedirect) {
      if ((redirectedUrl =
        await linkRedirectFunc(redirectedUrl as string,
          element, parent, this.options, this)) === undefined) {
        return undefined;
      }
    }
    return redirectedUrl;
  }

  async detectResourceType(
    url: string,
    type: ResourceType,
    element: Cheerio | null,
    parent: Resource | null
  ): Promise<ResourceType | void> {

    let detectedType: ResourceType | void = type;
    for (const detectResourceTypeFunc of this.lifeCycle.detectResourceType) {
      if ((detectedType =
          await detectResourceTypeFunc(url, detectedType as ResourceType,
            element, parent, this.options, this))
        === undefined) {
        return undefined;
      }
    }
    return detectedType;
  }

  createResource(
    type: ResourceType,
    depth: number,
    url: string,
    refUrl: string,
    localRoot?: string,
    encoding?: ResourceEncoding
  ): Resource {
    return this.lifeCycle.createResource(type, depth, url, refUrl,
      localRoot ?? this.options.localRoot,
      encoding ?? this.options.encoding[type] ?? 'utf8');
  }

  async processBeforeDownload(
    res: Resource,
    element: Cheerio | null,
    parent: Resource | null,
    options?: StaticDownloadOptions
  ): Promise<Resource | void> {
    if (!options) {
      options = this.options;
    }
    let processedResource: Resource | void = res;
    for (const processBeforeDownload of this.lifeCycle.processBeforeDownload) {
      if ((processedResource =
          await processBeforeDownload(processedResource as DownloadResource,
            element, parent, options, this))
        === undefined) {
        return undefined;
      }
    }
    return processedResource;
  }

  async download(
    res: Resource,
    requestOptions?: RequestOptions,
    options?: StaticDownloadOptions
  ): Promise<DownloadResource | void> {
    if (!requestOptions) {
      requestOptions = this.requestOptions;
    }
    if (!options) {
      options = this.options;
    }
    let downloadedResource: DownloadResource | Resource | void = res;
    for (const download of this.lifeCycle.download) {
      if ((downloadedResource = await download(
        downloadedResource as Resource, requestOptions, options, this))
        === undefined) {
        return undefined;
      }
      // if downloaded, end loop and return
      if ((downloadedResource as Resource)?.body) {
        return downloadedResource as DownloadResource;
      }
    }
    // not downloaded
    return undefined;
  }

  /**
   * Process resource after download, in worker thread
   * @param res resource received from main thread
   * @param submit function to submit resource to pipeline
   * @param options
   */
  async processAfterDownload(
    res: DownloadResource,
    submit: SubmitResourceFunc,
    options?: StaticDownloadOptions
  ): Promise<DownloadResource | void> {
    if (!options) {
      options = this.options;
    }
    let downloadedResource: DownloadResource | void = res;
    for (const processAfterDownload of this.lifeCycle.processAfterDownload) {
      if ((downloadedResource = await processAfterDownload(
        downloadedResource as DownloadResource, submit, options, this))
        === undefined) {
        return undefined;
      }
    }
    return downloadedResource;
  }

  async saveToDisk(
    res: DownloadResource,
    options?: StaticDownloadOptions
  ): Promise<DownloadResource | void> {
    if (!options) {
      options = this.options;
    }
    let downloadedResource: DownloadResource | void = res;
    for (const saveToDisk of this.lifeCycle.saveToDisk) {
      if ((downloadedResource = await saveToDisk(
        downloadedResource as DownloadResource, options, this))
        === undefined) {
        // already downloaded
        return undefined;
      }
    }
    // not downloaded
    return downloadedResource;
  }
}
