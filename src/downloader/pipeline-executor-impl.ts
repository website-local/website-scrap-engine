import type {Logger} from '../logger/types.js';
import type {PublicationStore} from '../output-store.js';
import type {BeforeRetryHook} from 'got';
import {beforeRetryHook} from '../life-cycle/retry-hook.js';
import {calculateFastDelay} from '../options.js';
import {createDefaultLogger} from '../logger/default-logger.js';
import {disposeHtmlResource} from '../cheerio.js';
import {isPromiseLike} from '../util.js';
import {checkResourceBody, checkResourceSize, ResourceSizeError} from '../resource-limits.js';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import type {Stats} from 'node:fs';
import URI from '../uri.js';
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

/** @internal Completed synchronous listeners need no per-notification tracking. */
export const completedStatusChange: Promise<void> = Promise.resolve();

/**
 * Pipeline executor
 */
export class PipelineExecutorImpl implements PipelineExecutor {
  readonly retryLogger: BeforeRetryHook = (error, count) => beforeRetryHook(error, count, this.logger);
  // Links from one document normally share their base. Keep only the last base,
  // and clone it so resource/hook mutations cannot affect subsequent links.
  refUrl?: string;
  refUri?: URI;
  constructor(public lifeCycle: ProcessingLifeCycle,
              public requestOptions: RequestOptions,
              public options: StaticDownloadOptions,
              public readonly signal?: AbortSignal,
              public readonly logger: Logger = createDefaultLogger(),
              public readonly publicationStore?: PublicationStore) {
    // Bind external-library callbacks once per executor, not once per request.
    this.requestOptions = {...requestOptions};
    if (requestOptions.hooks?.beforeRetry?.includes(beforeRetryHook)) {
      this.requestOptions.hooks = {...requestOptions.hooks,
        beforeRetry: requestOptions.hooks.beforeRetry.map(hook => hook === beforeRetryHook ? this.retryLogger : hook)};
    }
    if (requestOptions.retry?.calculateDelay === calculateFastDelay) {
      this.requestOptions.retry = {...requestOptions.retry,
        calculateDelay: retry => calculateFastDelay(retry, this.logger)};
    }
    if (signal && signal !== requestOptions.signal) {
      this.requestOptions.signal = requestOptions.signal ? AbortSignal.any([requestOptions.signal, signal]) : signal;
    }
  }

  async init(
    pipeline: PipelineExecutor,
    downloader?: DownloaderWithMeta,
    submit?: InitSubmitFunc
  ): Promise<void> {
    if (!this.lifeCycle.init) return;
    for (const init of this.lifeCycle.init) {
      this.signal?.throwIfAborted();
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
    this.signal?.throwIfAborted();
    const redirected = this.linkRedirect(rawUrl, element, parent);
    const url = isPromiseLike(redirected) ? await redirected : redirected;
    if (!url) return;
    const detected = this.detectResourceType(url, defaultType, element, parent);
    const type = isPromiseLike(detected) ? await detected : detected;
    if (!type) return;
    const refUrl = parent.redirectedUrl || parent.url;
    const savePath = refUrl === parent.url ? parent.savePath : undefined;
    const created = this.createResource(type, depth ?? parent.depth + 1, url,
      refUrl,
      parent.localRoot,
      this.options.encoding[type],
      savePath,
      parent.type);
    const r = isPromiseLike(created) ? await created : created;
    if (!r) return;
    return this.processBeforeDownload(r, element, parent, this.options);
  }

  linkRedirect(
    url: string,
    element: Cheerio | null,
    parent: Resource | null,
    startIndex = 0
  ): AsyncResult<string | void> {
    try {
      this.signal?.throwIfAborted();
      const hooks = this.lifeCycle.linkRedirect;
      for (let index = startIndex; index < hooks.length; index++) {
        const hook = hooks[index];
        const next = hook(url, element, parent, this.options, this);
        if (isPromiseLike(next)) return next.then(value => value === undefined ? undefined :
          this.linkRedirect(value, element, parent, index + 1));
        if (next === undefined) return;
        url = next;
        this.signal?.throwIfAborted();
      }
      return url;
    } catch (error) { return Promise.reject(error); }
  }

  detectResourceType(
    url: string,
    type: ResourceType,
    element: Cheerio | null,
    parent: Resource | null,
    startIndex = 0
  ): AsyncResult<ResourceType | void> {
    try {
      this.signal?.throwIfAborted();
      const hooks = this.lifeCycle.detectResourceType;
      for (let index = startIndex; index < hooks.length; index++) {
        const hook = hooks[index];
        const next = hook(url, type, element, parent, this.options, this);
        if (isPromiseLike(next)) return next.then(value => value === undefined ? undefined :
          this.detectResourceType(url, value, element, parent, index + 1));
        if (next === undefined) return;
        type = next;
        this.signal?.throwIfAborted();
      }
      return type;
    } catch (error) { return Promise.reject(error); }
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

  _createResourceWithSavePath(
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
  ): AsyncResult<Resource | void> {
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
          this.lifeCycle.generateSavePath?.length ? uri.clone() : uri : URI(resolvedUrl), refUri, this.logger) :
      this.lifeCycle.createResource(arg);
    if (!checkResourceBody(resource, this.options.maxResourceBytes, this.logger)) return disposeHtmlResource(resource);
    return resource;
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
    let savePath = replacePathHasError ? rawUrl : firstHook && firstHook.fullSavePath ? '' :
      builtinGenerateSavePath(uri, isHtml, keepSearch, localSrcRoot, this.logger);
    let resultRefSavePath = refSavePath || builtinGenerateSavePath(
      URI(refUrl), refType === ResourceType.Html, false, localSrcRoot, this.logger);

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
      options: this.options,
      pipeline: this
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

  async _continueGenerateSavePath(
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
    options: StaticDownloadOptions = this.options,
    startIndex = 0
  ): AsyncResult<Resource | void> {
    try {
      this.signal?.throwIfAborted();
      if (!checkResourceBody(res, this.options.maxResourceBytes, this.logger)) return disposeHtmlResource(res);
      const hooks = this.lifeCycle.processBeforeDownload;
      for (let index = startIndex; index < hooks.length; index++) {
        const hook = hooks[index];
        const next = hook(res, element, parent, options, this);
        if (isPromiseLike(next)) return (async () => {
          try {
            const resource = await next;
            if (!resource) { await disposeHtmlResource(res); return; }
            if (resource !== res) await this.replaceResource(res, resource);
            return await this.processBeforeDownload(resource, element, parent, options, index + 1);
          } catch (error) { await disposeHtmlResource(res); throw error; }
        })();
        if (!next) return disposeHtmlResource(res);
        if (next !== res) return this.replaceResource(res, next).then(() =>
          this.processBeforeDownload(next, element, parent, options, index + 1));
        this.signal?.throwIfAborted();
        if (!checkResourceBody(res, this.options.maxResourceBytes, this.logger)) return disposeHtmlResource(res);
      }
      if (res.shouldBeDiscardedFromDownload) {
        const disposing = disposeHtmlResource(res);
        if (disposing) return disposing.then(() => res);
      }
      return res;
    } catch (error) {
      const disposing = disposeHtmlResource(res);
      return disposing ? disposing.then(() => { throw error; }) : Promise.reject(error);
    }
  }

  async download(
    res: Resource,
    requestOptions: RequestOptions = this.requestOptions,
    options: StaticDownloadOptions = this.options
  ): Promise<DownloadResource | void> {
    let current = res;
    try {
      this.signal?.throwIfAborted();
      if (res.shouldBeDiscardedFromDownload) {
        const disposing = disposeHtmlResource(res);
        if (disposing) await disposing;
        return;
      }
      if (this.lifeCycle.existingResource) {
        const existing = await this._checkExistingResource(res, 'download');
        if (existing?.action === 'skip') {
          res.shouldBeDiscardedFromDownload = true;
          const disposing = disposeHtmlResource(res);
          if (disposing) await disposing;
          return;
        }
        if (existing?.action === 'ifModifiedSince') {
          requestOptions = {...requestOptions, headers: {...requestOptions.headers,
            'if-modified-since': existing.stat.mtime.toUTCString()}};
        }
      }
      if (this.signal && requestOptions.signal !== this.signal) {
        requestOptions = {...requestOptions, signal: requestOptions.signal ?
          AbortSignal.any([requestOptions.signal, this.signal]) : this.signal};
      }
      checkResourceBody(current, this.options.maxResourceBytes, this.logger);
      for (const download of this.lifeCycle.download) {
        this.signal?.throwIfAborted();
        if (current.shouldBeDiscardedFromDownload) {
          const disposing = disposeHtmlResource(current);
          if (disposing) await disposing;
          return;
        }
        const next = await download(current, requestOptions, options, this);
        if (!next) {
          const disposing = disposeHtmlResource(current);
          if (disposing) await disposing;
          return;
        }
        if (next !== current) {
          await this.replaceResource(current, next);
          current = next;
        }
        this.signal?.throwIfAborted();
        checkResourceBody(current, this.options.maxResourceBytes, this.logger);
        if (current.shouldBeDiscardedFromDownload) {
          const disposing = disposeHtmlResource(current);
          if (disposing) await disposing;
          return;
        }
        if (current.body !== undefined) {
          current.downloaded = true;
          return current as DownloadResource;
        }
      }
      const disposing = disposeHtmlResource(current);
      if (disposing) await disposing;
    } catch (error) {
      const disposing = disposeHtmlResource(current);
      if (disposing) await disposing;
      // Got wraps stream errors in RequestError while retaining their cause.
      const sizeError = error instanceof ResourceSizeError ? error :
        error instanceof Error && error.cause instanceof ResourceSizeError ? error.cause : undefined;
      if (sizeError) {
        checkResourceSize(sizeError.actual, sizeError.limit, current, this.logger);
        return;
      }
      throw error;
    } finally {
      res.downloaded = current.downloaded;
      res.publishedFiles = current.publishedFiles;
      res.shouldBeDiscardedFromDownload = current.shouldBeDiscardedFromDownload;
    }
  }

  async processAfterDownload(
    res: DownloadResource,
    submit: SubmitResourceFunc,
    options: StaticDownloadOptions = this.options
  ): Promise<DownloadResource | void> {
    let current = res;
    try {
      this.signal?.throwIfAborted();
      checkResourceBody(current, this.options.maxResourceBytes, this.logger);
      for (const process of this.lifeCycle.processAfterDownload) {
        this.signal?.throwIfAborted();
        if (current.shouldBeDiscardedFromDownload) {
          const disposing = disposeHtmlResource(current);
          if (disposing) await disposing;
          return;
        }
        const next = await process(current, submit, options, this);
        if (!next) {
          const disposing = disposeHtmlResource(current);
          if (disposing) await disposing;
          return;
        }
        if (next !== current) {
          await this.replaceResource(current, next);
          current = next;
        }
        checkResourceBody(current, this.options.maxResourceBytes, this.logger);
      }
      this.signal?.throwIfAborted();
      if (current.shouldBeDiscardedFromDownload) {
        const disposing = disposeHtmlResource(current);
        if (disposing) await disposing;
        return;
      }
      return current;
    } catch (error) {
      const disposing = disposeHtmlResource(current);
      if (disposing) await disposing;
      throw error;
    } finally {
      current.discoveredCount = undefined;
      res.discoveredCount = undefined;
      res.downloaded = current.downloaded;
      res.publishedFiles = current.publishedFiles;
      res.shouldBeDiscardedFromDownload = current.shouldBeDiscardedFromDownload;
    }
  }

  async saveToDisk(
    res: DownloadResource,
    options: StaticDownloadOptions = this.options
  ): Promise<DownloadResource | void> {
    let current = res;
    try {
      this.signal?.throwIfAborted();
      if (!await this.shouldSaveResource(res)) {
        const disposing = disposeHtmlResource(res);
        if (disposing) await disposing;
        return;
      }
      checkResourceBody(current, this.options.maxResourceBytes, this.logger);
      for (const save of this.lifeCycle.saveToDisk) {
        this.signal?.throwIfAborted();
        if (current.shouldBeDiscardedFromDownload) {
          const disposing = disposeHtmlResource(current);
          if (disposing) await disposing;
          return;
        }
        const next = await save(current, options, this);
        if (!next) {
          const disposing = disposeHtmlResource(current);
          if (disposing) await disposing;
          return;
        }
        if (next !== current) {
          await this.replaceResource(current, next);
          current = next;
        }
        checkResourceBody(current, this.options.maxResourceBytes, this.logger);
      }
      this.signal?.throwIfAborted();
      if (current.shouldBeDiscardedFromDownload) {
        const disposing = disposeHtmlResource(current);
        if (disposing) await disposing;
        return;
      }
      return current;
    } catch (error) {
      const disposing = disposeHtmlResource(current);
      if (disposing) await disposing;
      throw error;
    } finally {
      res.downloaded = current.downloaded;
      res.publishedFiles = current.publishedFiles;
      res.shouldBeDiscardedFromDownload = current.shouldBeDiscardedFromDownload;
    }
  }

  async replaceResource(previous: Resource, next: Resource): Promise<void> {
    next.workerTaskId = previous.workerTaskId;
    next.publicationOwner = previous.publicationOwner;
    next.downloaded = previous.downloaded;
    next.publishedFiles = previous.publishedFiles;
    next.shouldBeDiscardedFromDownload ||= previous.shouldBeDiscardedFromDownload;
    next.discoveredCount = previous.discoveredCount;
    previous.discoveredCount = undefined;
    try {
      if (previous.meta.doc && previous.meta.doc === next.meta.doc) {
        if (previous.meta.statusChanges) {
          for (const pending of previous.meta.statusChanges) await pending;
        }
        if (previous.meta !== next.meta) previous.meta.doc = undefined;
      } else {
        const disposing = disposeHtmlResource(previous);
        if (disposing) await disposing;
      }
    } catch (error) {
      next.discoveredCount = undefined;
      try {
        const disposing = disposeHtmlResource(next);
        if (disposing) await disposing;
      } catch (nextError) {
        throw new AggregateError([error, nextError], 'Resource replacement cleanup failed', {cause: nextError});
      }
      throw error;
    }
  }

  async shouldSaveResource(res: Resource): Promise<boolean> {
    this.signal?.throwIfAborted();
    if (!checkResourceBody(res, this.options.maxResourceBytes, this.logger)) return false;
    if (this.lifeCycle.existingResource) {
      const existing = await this._checkExistingResource(res, 'saveToDisk');
      if (existing?.action === 'skip' || existing?.action === 'skipSave') {
        res.shouldBeDiscardedFromDownload = true;
        return false;
      }
      if (existing?.action === 'ifModifiedSince') {
        const remoteLastMod = res.meta?.headers?.['last-modified'];
        if (remoteLastMod &&
          new Date(remoteLastMod as string) <= existing.stat.mtime) {
          res.shouldBeDiscardedFromDownload = true;
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

  notifyStatusChange(
    res: Resource | RawResource,
    status: ResourceStatus
  ): Promise<void> {
    try {
      const listeners = this.lifeCycle.statusChange;
      if (!listeners?.length) return completedStatusChange;
      let pending: Promise<void>[] | undefined;
      for (const listener of listeners) {
        try {
          const result = listener(res, status, this.options, this);
          if (result) (pending ??= []).push(result);
        } catch {
          // Every observer runs after a synchronous failure.
        }
      }
      if (!pending) return completedStatusChange;
      const notification = Promise.allSettled(pending).then(() => undefined);
      (res.meta.statusChanges ??= []).push(notification);
      return notification;
    } catch (error) { return Promise.reject(error); }
  }

  async _checkExistingResource(
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

  _resolveUri(
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
        this.options.localSrcRoot, this.options.skipReplacePathError, this.logger);
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
        url, refUrl, type, this.logger)) {
      replacePathHasError = true;
    }

    return {uri, refUri, url: uri.toString(), keepSearch, replacePathHasError};
  }

}
