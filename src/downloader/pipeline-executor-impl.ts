import {currentCrawlContext, throwIfCancelled, markResourceDownloaded, markResourceSkipped} from '../crawl-context.js';
import {prepareHtmlParser} from '../cheerio.js';
import {fullSavePathHooks} from '../life-cycle/save-path-hook-state.js';
import {isPromiseLike} from '../util.js';
import {checkResourceBody, checkAndAccountResourceBody} from '../resource-limits.js';
import path from 'node:path';
import {promises as fs} from 'node:fs';
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
  createResource as builtinCreateResource,
  createResourceWithUris,
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
  // Links from one document normally share their base. Keep only the last base,
  // and clone it so resource/hook mutations cannot affect subsequent links.
  private refUrl?: string;
  private refUri?: URI;
  constructor(public lifeCycle: ProcessingLifeCycle,
              public requestOptions: RequestOptions,
              public options: StaticDownloadOptions,
              public readonly signal?: AbortSignal) {
  }

  private checkResource(res: Resource): Resource {
    checkResourceBody(res, this.options.maxResourceBytes);
    return res;
  }

  async init(
    pipeline: PipelineExecutor,
    downloader?: DownloaderWithMeta,
    submit?: InitSubmitFunc
  ): Promise<void> {
    if (!this.lifeCycle.init) return;
    for (const init of this.lifeCycle.init) {
      throwIfCancelled(this.signal);
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
    throwIfCancelled(this.signal);
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

  private runHooks<T, H>(
    initial: T,
    hooks: H[],
    invoke: (hook: H, value: T) => AsyncResult<T | void>,
    validate?: (value: T) => void
  ): AsyncResult<T | void> {
    const run = (index: number, value: T | void): AsyncResult<T | void> => {
      throwIfCancelled(this.signal);
      if (value === undefined) return;
      if (validate) validate(value);
      for (; index < hooks.length; index++) {
        throwIfCancelled(this.signal);
        const result = invoke(hooks[index], value);
        if (isPromiseLike(result)) return result.then(value => run(index + 1, value));
        if (result === undefined) return;
        value = result;
        if (validate) validate(value);
      }
      throwIfCancelled(this.signal);
      return value;
    };
    try { return run(0, initial); }
    catch (error) { return Promise.reject(error); }
  }

  linkRedirect(
    url: string,
    element: Cheerio | null,
    parent: Resource | null
  ): AsyncResult<string | void> {
    return this.runHooks(url, this.lifeCycle.linkRedirect,
      (fn, value) => fn(value, element, parent, this.options, this));
  }

  detectResourceType(
    url: string,
    type: ResourceType,
    element: Cheerio | null,
    parent: Resource | null
  ): AsyncResult<ResourceType | void> {
    return this.runHooks(type, this.lifeCycle.detectResourceType,
      (fn, value) => fn(url, value, element, parent, this.options, this));
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
    if (isPromiseLike(savePathResult)) {
      return savePathResult.then(result => this._createResourceWithSavePath(
        result, type, depth, resolved.url, url, refUrl, localRoot, encoding,
        resolved.keepSearch, resolved.replacePathHasError, resolved.uri, resolved.refUri));
    }
    return this._createResourceWithSavePath(
      savePathResult, type, depth, resolved.url, url, refUrl, localRoot,
      encoding, resolved.keepSearch, resolved.replacePathHasError, resolved.uri, resolved.refUri);
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
    replacePathHasError: boolean,
    uri: URI,
    refUri: URI
  ): Resource | void {
    if (!savePathResult) {
      return undefined;
    }
    const resourceEncoding = encoding === undefined ?
      this.options.encoding[type] : encoding;
    const arg: CreateResourceArgument = {
      type,
      depth,
      url: resolvedUrl,
      rawUrl,
      refUrl,
      refSavePath: savePathResult.refSavePath,
      localRoot: localRoot ?? this.options.localRoot,
      encoding: resourceEncoding === undefined ?
        (type === ResourceType.Binary || type === ResourceType.StreamingBinary ?
          null : 'utf8') : resourceEncoding,
      keepSearch,
      skipReplacePathError: this.options.skipReplacePathError,
      savePath: savePathResult.savePath,
      replacePathHasError
    };
    // Save-path hooks may mutate their URI; URL strings remain authoritative.
    // Custom resource factories keep their existing one-argument contract.
    const resource = this.lifeCycle.createResource === builtinCreateResource ?
      createResourceWithUris(arg,
        uri.toString() === resolvedUrl ?
          this.lifeCycle.generateSavePath?.length ? uri.clone() : uri : URI(resolvedUrl), refUri) :
      this.lifeCycle.createResource(arg);
    return this.checkResource(resource);
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
    const firstHook = this.lifeCycle.generateSavePath?.[0];
    // A full generator overwrites this input; transforming hooks still receive
    // the built-in path, including when they precede a legacy adapter.
    let savePath = replacePathHasError ? rawUrl : firstHook && fullSavePathHooks.has(firstHook) ? '' :
      builtinGenerateSavePath(uri, isHtml, keepSearch, localSrcRoot);
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
      if (isPromiseLike(result)) {
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

  processBeforeDownload(
    res: Resource,
    element: Cheerio | null,
    parent: Resource | null,
    options: StaticDownloadOptions = this.options
  ): AsyncResult<Resource | void> {
    return this.runHooks(res, this.lifeCycle.processBeforeDownload,
      (fn, value) => fn(value, element, parent, options, this),
      value => { this.checkResource(value); });
  }

  async download(
    res: Resource,
    requestOptions?: RequestOptions,
    options?: StaticDownloadOptions
  ): Promise<DownloadResource | void> {
    throwIfCancelled(this.signal);
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
      const existing = await this._checkExistingResource(res, 'download');
      if (existing?.action === 'skip') {
        res.shouldBeDiscardedFromDownload = true;
        return undefined;
      }
      if (existing?.action === 'ifModifiedSince') {
        requestOptions = Object.assign({}, requestOptions);
        requestOptions.headers = Object.assign({}, requestOptions.headers, {
          'if-modified-since': existing.stat.mtime.toUTCString()
        });
      }
    }
    const signal = this.signal ?? currentCrawlContext()?.signal;
    if (signal) {
      requestOptions = {...requestOptions, signal: requestOptions.signal ?
        AbortSignal.any([requestOptions.signal, signal]) : signal};
    }
    let downloadedResource: DownloadResource | Resource | void = res;
    const accounting = checkAndAccountResourceBody(downloadedResource, this.options.maxResourceBytes);
    if (accounting) await accounting;
    for (const download of this.lifeCycle.download) {
      throwIfCancelled(this.signal);
      if ((downloadedResource = await download(
        downloadedResource as Resource, requestOptions, options, this))
        === undefined) {
        return undefined;
      }
      throwIfCancelled(this.signal);
      const accounting = checkAndAccountResourceBody(downloadedResource, this.options.maxResourceBytes);
      if (accounting) await accounting;
      // if downloaded, end loop and return
      if (downloadedResource.body !== undefined) {
        markResourceDownloaded();
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
    throwIfCancelled(this.signal);
    if (res.type === ResourceType.Html || res.type === ResourceType.Svg || res.type === ResourceType.SiteMap) {
      const loading = prepareHtmlParser();
      if (loading) await loading;
    }
    if (!options) {
      options = this.options;
    }
    let downloadedResource: DownloadResource | void = res;
    const accounting = checkAndAccountResourceBody(downloadedResource, this.options.maxResourceBytes);
    if (accounting) await accounting;
    for (const processAfterDownload of this.lifeCycle.processAfterDownload) {
      throwIfCancelled(this.signal);
      if ((downloadedResource = await processAfterDownload(
        downloadedResource as DownloadResource, submit, options, this))
        === undefined) {
        return undefined;
      }
      const accounting = checkAndAccountResourceBody(downloadedResource, this.options.maxResourceBytes);
      if (accounting) await accounting;
    }
    throwIfCancelled(this.signal);
    return downloadedResource as DownloadResource;
  }

  async saveToDisk(
    res: DownloadResource,
    options?: StaticDownloadOptions
  ): Promise<DownloadResource | void> {
    throwIfCancelled(this.signal);
    if (!options) {
      options = this.options;
    }
    if (!await this.shouldSaveResource(res)) return undefined;
    let downloadedResource: DownloadResource | void = res;
    const accounting = checkAndAccountResourceBody(downloadedResource, this.options.maxResourceBytes);
    if (accounting) await accounting;
    for (const saveToDisk of this.lifeCycle.saveToDisk) {
      throwIfCancelled(this.signal);
      if ((downloadedResource = await saveToDisk(
        downloadedResource as DownloadResource, options, this))
        === undefined) {
        // already downloaded
        return undefined;
      }
      const accounting = checkAndAccountResourceBody(downloadedResource, this.options.maxResourceBytes);
      if (accounting) await accounting;
    }
    // not downloaded
    throwIfCancelled(this.signal);
    return downloadedResource as DownloadResource;
  }

  async shouldSaveResource(res: Resource): Promise<boolean> {
    throwIfCancelled(this.signal);
    this.checkResource(res);
    if (this.lifeCycle.existingResource) {
      const existing = await this._checkExistingResource(res, 'saveToDisk');
      if (existing?.action === 'skip' || existing?.action === 'skipSave') {
        markResourceSkipped();
        return false;
      }
      if (existing?.action === 'ifModifiedSince') {
        const remoteLastMod = res.meta?.headers?.['last-modified'];
        if (remoteLastMod &&
          new Date(remoteLastMod as string) <= existing.stat.mtime) {
          markResourceSkipped();
          return false;
        }
      }
    }
    return true;
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

  private async _checkExistingResource(
    res: Resource, stage: ExistingResourceStage
  ): Promise<{action: ExistingResourceAction; stat: Stats} | void> {
    const localPath = path.join(
      res.localRoot ?? this.options.localRoot,
      decodeURI(res.savePath)
    );
    let stat: Stats;
    try {
      stat = await fs.stat(localPath);
    } catch {
      return undefined;
    }
    if (!stat.isFile()) return undefined;
    return {
      action: this.lifeCycle.existingResource!({
        res, stage, localPath, stat, options: this.options
      }),
      stat
    };
  }

  private _resolveUri(
    rawUrl: string,
    refUrl: string,
    type: ResourceType
  ): {
    uri: URI;
    refUri: URI;
    url: string;
    keepSearch: boolean;
    replacePathHasError: boolean;
  } {
    let url = rawUrl;
    if (this.refUrl !== refUrl) {
      this.refUri = URI(refUrl);
      this.refUrl = refUrl;
    }
    const refUri = this.refUri!.clone();
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
    if (!replacePathHasError && !uri.hostname() && uri.is('relative')) {
      uri = uri.absoluteTo(refUri);
      url = uri.toString();
    }
    if (!replacePathHasError &&
      checkAbsoluteUri(uri, refUri, this.options.skipReplacePathError,
        url, refUrl, type)) {
      replacePathHasError = true;
    }

    return {uri, refUri, url, keepSearch, replacePathHasError};
  }

}
