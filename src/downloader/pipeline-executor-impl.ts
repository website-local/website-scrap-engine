import type {StaticDownloadOptions} from '../options';
import type {
  CreateResourceArgument,
  Resource,
  ResourceEncoding,
  ResourceType
} from '../resource';
import type {
  DownloadResource,
  ProcessingLifeCycle,
  RequestOptions,
  SubmitResourceFunc
} from '../life-cycle/types';
// noinspection ES6PreferShortImport
import type {PipelineExecutor} from '../life-cycle/pipeline-executor';
import type {Cheerio} from '../types';

/**
 * Pipeline executor
 */
export class PipelineExecutorImpl implements PipelineExecutor {
  constructor(public lifeCycle: ProcessingLifeCycle,
              public requestOptions: RequestOptions,
              public options: StaticDownloadOptions) {
  }

  async createAndProcessResource(
    rawUrl: string,
    defaultType: ResourceType,
    depth: number | void | null,
    element: Cheerio | null,
    parent: Resource
  ): Promise<Resource | void> {
    const url: string | void = await this.linkRedirect(rawUrl, element, parent);
    if (!url) return;
    const type = await this.detectResourceType(url, defaultType, element, parent);
    if (!type) return;
    const r = await this.createResource(type, depth || parent.depth + 1, url,
      parent.redirectedUrl || parent.url,
      parent.localRoot,
      this.options.encoding[type],
      parent.savePath,
      parent.type);
    if (!r) return;
    return await this.processBeforeDownload(r, element, parent, this.options);
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
    encoding?: ResourceEncoding,
    refSavePath?: string,
    refType?: ResourceType
  ): Resource {
    const arg: CreateResourceArgument = {
      type,
      depth,
      url,
      refUrl,
      refSavePath,
      refType,
      localRoot: localRoot ?? this.options.localRoot,
      localSrcRoot: this.options.localSrcRoot,
      encoding: encoding ?? this.options.encoding[type] ?? 'utf8',
      keepSearch: this.options.deduplicateStripSearch,
      skipReplacePathError: this.options.skipReplacePathError
    };
    return this.lifeCycle.createResource(arg);
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
    if (res.shouldBeDiscardedFromDownload) {
      return undefined;
    }
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
