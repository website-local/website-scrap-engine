import path from 'node:path';
import {existsSync, statSync} from 'node:fs';
import type {Stats} from 'node:fs';
import URI from 'urijs';
import type {StaticDownloadOptions} from '../options.js';
import type {
  CreateResourceArgument,
  RawResource,
  Resource,
  ResourceEncoding
} from '../resource.js';
import {
  checkAbsoluteUri,
  FILE_PROTOCOL_PREFIX,
  generateSavePath as builtinGenerateSavePath,
  resolveFileUrl,
  ResourceType
} from '../resource.js';
import type {
  AsyncResult,
  DownloadResource,
  ExistingResourceAction,
  ExistingResourceStage,
  GenerateSavePathContext,
  GenerateSavePathFunc,
  GenerateSavePathResult,
  InitSubmitFunc,
  ProcessingLifeCycle,
  RequestOptions,
  ResourceStatus,
  SubmitResourceFunc
} from '../life-cycle/types.js';
// noinspection ES6PreferShortImport
import type {PipelineExecutor} from '../life-cycle/pipeline-executor.js';
import type {Cheerio} from '../types.js';
import type {DownloaderWithMeta} from './types.js';
import type {WorkerInfo} from './worker-pool.js';

type Mutable<T> = {-readonly [P in keyof T]: T[P]};
type SavePathState = {savePath: string; refSavePath: string};

/**
 * Pipeline executor
 */
export class PipelineExecutorImpl implements PipelineExecutor {
  constructor(public lifeCycle: ProcessingLifeCycle,
              public requestOptions: RequestOptions,
              public options: StaticDownloadOptions) {
  }

  async init(
    pipeline: PipelineExecutor,
    downloader?: DownloaderWithMeta,
    submit?: InitSubmitFunc
  ): Promise<void> {
    if (!this.lifeCycle.init) return;
    for (const init of this.lifeCycle.init) {
      await init(pipeline, downloader, submit);
    }
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
    const refUrl = parent.redirectedUrl || parent.url;
    const savePath = refUrl === parent.url ? parent.savePath : undefined;
    const r = await this.createResource(type, depth || parent.depth + 1, url,
      refUrl,
      parent.localRoot,
      this.options.encoding[type],
      savePath,
      parent.type);
    if (!r) return;
    return await this.processBeforeDownload(r, element, parent, this.options);
  }

  async linkRedirect(
    url: string,
    element: Cheerio | null,
    parent: Resource | null
  ): Promise<string | void> {
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
  ): AsyncResult<Resource | void> {
    const resolved = this._resolveUri(url, refUrl, type);
    const savePathResult = this.generateSavePath(
      resolved.uri, type, depth, url, refUrl, resolved.keepSearch,
      resolved.replacePathHasError, refSavePath, refType);
    if (this._isPromiseLike(savePathResult)) {
      return savePathResult.then(result => this._createResourceWithSavePath(
        result, type, depth, resolved.url, url, refUrl, localRoot, encoding,
        resolved.keepSearch, resolved.replacePathHasError));
    }
    return this._createResourceWithSavePath(
      savePathResult, type, depth, resolved.url, url, refUrl, localRoot,
      encoding, resolved.keepSearch, resolved.replacePathHasError);
  }

  private _createResourceWithSavePath(
    savePathResult: SavePathState | void,
    type: ResourceType,
    depth: number,
    resolvedUrl: string,
    rawUrl: string,
    refUrl: string,
    localRoot: string | undefined,
    encoding: ResourceEncoding | undefined,
    keepSearch: boolean,
    replacePathHasError: boolean
  ): Resource | void {
    if (!savePathResult) {
      return undefined;
    }
    const arg: CreateResourceArgument = {
      type,
      depth,
      url: resolvedUrl,
      rawUrl,
      refUrl,
      refSavePath: savePathResult.refSavePath,
      localRoot: localRoot ?? this.options.localRoot,
      encoding: encoding ?? this.options.encoding[type] ?? 'utf8',
      keepSearch,
      skipReplacePathError: this.options.skipReplacePathError,
      savePath: savePathResult.savePath,
      replacePathHasError
    };
    return this.lifeCycle.createResource(arg);
  }

  generateSavePath(
    uri: URI,
    type: ResourceType,
    depth: number,
    rawUrl: string,
    refUrl: string,
    keepSearch: boolean,
    replacePathHasError: boolean,
    refSavePath?: string,
    refType?: ResourceType
  ): AsyncResult<SavePathState | void> {
    const isHtml = type === ResourceType.Html;
    const localSrcRoot = this.options.localSrcRoot;
    let savePath = replacePathHasError ? rawUrl : builtinGenerateSavePath(
      uri, isHtml, keepSearch, localSrcRoot);
    let resultRefSavePath = refSavePath || builtinGenerateSavePath(
      URI(refUrl), refType === ResourceType.Html, false, localSrcRoot);

    if (!this.lifeCycle.generateSavePath?.length) {
      return {savePath, refSavePath: resultRefSavePath};
    }

    const context: Mutable<GenerateSavePathContext> = {
      uri,
      type,
      depth,
      rawUrl,
      refUrl,
      refSavePath: resultRefSavePath,
      refType,
      replacePathHasError,
      options: this.options
    };

    const hooks = this.lifeCycle.generateSavePath;
    for (let index = 0; index < hooks.length; index++) {
      const fn = hooks[index];
      const result = fn(savePath, context);
      if (this._isPromiseLike(result)) {
        return this._continueGenerateSavePath(
          result, hooks, index + 1, savePath, resultRefSavePath, context);
      }
      if (result === undefined) {
        return undefined;
      }
      if (typeof result === 'string') {
        savePath = result;
      } else {
        savePath = result.savePath;
        if (result.refSavePath !== undefined) {
          resultRefSavePath = result.refSavePath;
          context.refSavePath = resultRefSavePath;
        }
      }
    }
    return {savePath, refSavePath: resultRefSavePath};
  }

  private async _continueGenerateSavePath(
    pendingResult: PromiseLike<string | GenerateSavePathResult | void>,
    hooks: GenerateSavePathFunc[],
    index: number,
    savePath: string,
    refSavePath: string,
    context: Mutable<GenerateSavePathContext>
  ): Promise<SavePathState | void> {
    let result: string | GenerateSavePathResult | void = await pendingResult;
    while (true) {
      if (result === undefined) {
        return undefined;
      }
      if (typeof result === 'string') {
        savePath = result;
      } else {
        savePath = result.savePath;
        if (result.refSavePath !== undefined) {
          refSavePath = result.refSavePath;
          context.refSavePath = refSavePath;
        }
      }
      if (index >= hooks.length) {
        return {savePath, refSavePath};
      }
      result = await hooks[index](savePath, context);
      index++;
    }
  }

  private _isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
    return !!value && typeof (value as PromiseLike<T>).then === 'function';
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
    if (this.lifeCycle.existingResource) {
      const action = this._checkExistingResource(res, 'download');
      if (action === 'skip') {
        res.shouldBeDiscardedFromDownload = true;
        return undefined;
      }
      if (action === 'ifModifiedSince') {
        const mtime = this._getExistingFileMtime(res);
        if (mtime) {
          requestOptions = Object.assign({}, requestOptions);
          requestOptions.headers = Object.assign({}, requestOptions.headers, {
            'if-modified-since': mtime
          });
        }
      }
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
    if (this.lifeCycle.existingResource) {
      const action = this._checkExistingResource(res, 'saveToDisk');
      if (action === 'skip' || action === 'skipSave') {
        return undefined;
      }
      if (action === 'ifModifiedSince') {
        const remoteLastMod = res.meta?.headers?.['last-modified'];
        if (remoteLastMod) {
          const localPath = path.join(
            res.localRoot ?? this.options.localRoot,
            decodeURI(res.savePath)
          );
          try {
            const localMtime = statSync(localPath).mtime;
            if (new Date(remoteLastMod as string) <= localMtime) {
              return undefined;
            }
          } catch {
            // file removed between check and stat, proceed with save
          }
        }
      }
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

  async dispose(
    pipeline: PipelineExecutor,
    downloader: DownloaderWithMeta,
    workerInfo?: WorkerInfo,
    workerExitCode?: number
  ): Promise<void> {
    if (!this.lifeCycle.dispose) return;
    for (const dispose of this.lifeCycle.dispose) {
      await dispose(pipeline, downloader, workerInfo, workerExitCode);
    }
  }

  async notifyStatusChange(
    res: Resource | RawResource,
    status: ResourceStatus
  ): Promise<void> {
    if (!this.lifeCycle.statusChange?.length) return;
    for (const listener of this.lifeCycle.statusChange) {
      try {
        const r = listener(res, status, this.options, this);
        if (r) await r;
      } catch {
        // swallow
      }
    }
  }

  private _checkExistingResource(
    res: Resource, stage: ExistingResourceStage
  ): ExistingResourceAction | void {
    const localPath = path.join(
      res.localRoot ?? this.options.localRoot,
      decodeURI(res.savePath)
    );
    if (!existsSync(localPath)) return undefined;
    let stat: Stats;
    try {
      stat = statSync(localPath);
    } catch {
      // TOCTOU: file deleted between existsSync and statSync
      return undefined;
    }
    if (!stat.isFile()) return undefined;
    return this.lifeCycle.existingResource!({
      res, stage, localPath, stat, options: this.options
    });
  }

  private _getExistingFileMtime(res: Resource): string | undefined {
    const localPath = path.join(
      res.localRoot ?? this.options.localRoot,
      decodeURI(res.savePath)
    );
    try {
      return statSync(localPath).mtime.toUTCString();
    } catch {
      return undefined;
    }
  }

  private _resolveUri(
    rawUrl: string,
    refUrl: string,
    type: ResourceType
  ): {
    uri: URI;
    url: string;
    keepSearch: boolean;
    replacePathHasError: boolean;
  } {
    let url = rawUrl;
    const refUri: URI = URI(refUrl);
    let replacePathHasError = false;
    let keepSearch = !this.options.deduplicateStripSearch;

    if (url.startsWith(FILE_PROTOCOL_PREFIX) ||
      refUrl.startsWith(FILE_PROTOCOL_PREFIX)) {
      // File downloadLink and savePath should never include search params.
      keepSearch = false;
      url = resolveFileUrl(url, refUrl,
        this.options.localSrcRoot, this.options.skipReplacePathError);
      if (!url) {
        replacePathHasError = true;
        url = rawUrl;
      }
    }
    if (!replacePathHasError && url.startsWith('//')) {
      url = refUri.protocol() + ':' + url;
    } else if (!replacePathHasError && url[0] === '/') {
      url = refUri.protocol() + '://' + refUri.host() + url;
    }

    let uri = URI(url);
    if (!replacePathHasError && uri.is('relative')) {
      uri = uri.absoluteTo(refUri);
      url = uri.toString();
    }
    if (!replacePathHasError &&
      checkAbsoluteUri(uri, refUri, this.options.skipReplacePathError,
        url, refUrl, type)) {
      replacePathHasError = true;
    }

    return {uri, url, keepSearch, replacePathHasError};
  }

}
