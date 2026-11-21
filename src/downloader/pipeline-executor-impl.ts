import path from 'node:path';
import {promises as fs} from 'node:fs';
import type {Stats} from 'node:fs';
import URI from '../uri.js';
import {disposeHtmlResource} from '../cheerio.js';
import type {HtmlParserOptions} from '../cheerio.js';
import {isPromiseLike} from '../util.js';
import type {StaticDownloadOptions} from '../options.js';
import type {CreateResourceArgument, RawResource, Resource, ResourceEncoding} from '../resource.js';
import {createResource as builtinCreateResource, createResourceWithUris, ResourceType} from '../resource.js';
import type {
  AsyncResult,
  DownloadResource,
  ExistingResourceAction,
  ExistingResourceStage,
  InitSubmitFunc,
  ProcessingLifeCycle,
  RequestOptions,
  ResourceStatus,
  SubmitResourceFunc
} from '../life-cycle/types.js';
import type {PipelineExecutor} from '../life-cycle/pipeline-executor.js';
import type {Cheerio} from '../types.js';
import type {DownloaderWithMeta} from './types.js';
import type {WorkerInfo} from './worker-pool.js';

/** Synchronous status listeners share one completed result. */
export const completedStatusChange: Promise<void> = Promise.resolve();

function disposeOnFailure(resource: Resource, error: unknown): Promise<never> {
  try {
    const disposing = disposeHtmlResource(resource);
    return disposing ? disposing.then(() => { throw error; }, cleanupError => {
      throw new AggregateError([error, cleanupError], 'Resource cleanup failed', {cause: cleanupError});
    }) : Promise.reject(error);
  } catch (cleanupError) {
    return Promise.reject(new AggregateError([error, cleanupError], 'Resource cleanup failed', {cause: cleanupError}));
  }
}

/** Execute the 0.9.1 lifecycle, preserving synchronous hook results. */
export class PipelineExecutorImpl implements PipelineExecutor {
  private refUrl?: string;
  private refUri?: URI;

  constructor(public lifeCycle: ProcessingLifeCycle,
              public requestOptions: RequestOptions,
              public options: StaticDownloadOptions & HtmlParserOptions) {
  }

  init(
    pipeline: PipelineExecutor,
    downloader?: DownloaderWithMeta,
    submit?: InitSubmitFunc
  ): void | Promise<void> {
    const hooks = this.lifeCycle.init;
    if (!hooks?.length) return;
    try {
      for (let index = 0; index < hooks.length; index++) {
        const init = hooks[index];
        const initialized = init(pipeline, downloader, submit);
        if (isPromiseLike(initialized)) return (async () => {
          await initialized;
          for (++index; index < hooks.length; index++) {
            const init = hooks[index];
            const next = init(pipeline, downloader, submit);
            if (isPromiseLike(next)) await next;
          }
        })();
      }
    } catch (error) { return Promise.reject(error); }
  }

  async createAndProcessResource(
    rawUrl: string,
    defaultType: ResourceType,
    depth: number | void | null,
    element: Cheerio | null,
    parent: Resource
  ): Promise<Resource | void> {
    const redirected = this.linkRedirect(rawUrl, element, parent);
    const url = isPromiseLike(redirected) ? await redirected : redirected;
    if (!url) return;
    const detected = this.detectResourceType(url, defaultType, element, parent);
    const type = isPromiseLike(detected) ? await detected : detected;
    if (!type) return;
    const refUrl = parent.redirectedUrl || parent.url;
    const savePath = refUrl === parent.url ? parent.savePath : undefined;
    const resource = this.createResource(type, depth ?? parent.depth + 1, url,
      refUrl, parent.localRoot, this.options.encoding[type], savePath, parent.type);
    return this.processBeforeDownload(resource, element, parent, this.options);
  }

  linkRedirect(
    url: string,
    element: Cheerio | null,
    parent: Resource | null,
    startIndex = 0
  ): AsyncResult<string | void> {
    try {
      const hooks = this.lifeCycle.linkRedirect;
      for (let index = startIndex; index < hooks.length; index++) {
        const hook = hooks[index];
        const next = hook(url, element, parent, this.options, this);
        if (isPromiseLike(next)) return Promise.resolve(next).then(value => value === undefined ? undefined :
          this.linkRedirect(value, element, parent, index + 1));
        if (next === undefined) return;
        url = next;
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
      const hooks = this.lifeCycle.detectResourceType;
      for (let index = startIndex; index < hooks.length; index++) {
        const hook = hooks[index];
        const next = hook(url, type, element, parent, this.options, this);
        if (isPromiseLike(next)) return Promise.resolve(next).then(value => value === undefined ? undefined :
          this.detectResourceType(url, value, element, parent, index + 1));
        if (next === undefined) return;
        type = next;
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
  ): Resource {
    const resourceEncoding = encoding === undefined ? this.options.encoding[type] : encoding;
    const arg: CreateResourceArgument = {
      type, depth, url, refUrl, refSavePath, refType,
      localRoot: localRoot ?? this.options.localRoot,
      localSrcRoot: this.options.localSrcRoot,
      encoding: resourceEncoding === undefined ?
        (type === ResourceType.Binary || type === ResourceType.StreamingBinary ? null : 'utf8') : resourceEncoding,
      keepSearch: !this.options.deduplicateStripSearch,
      skipReplacePathError: this.options.skipReplacePathError,
      generateSavePathFn: this.lifeCycle.generateSavePath || undefined
    };
    if (this.lifeCycle.createResource !== builtinCreateResource) return this.lifeCycle.createResource(arg);
    // Only the last base is retained. Each resource owns a clone, so mutable
    // resource URIs and custom path generators cannot corrupt later links.
    if (this.refUrl !== refUrl) {
      this.refUri = URI(refUrl);
      this.refUrl = refUrl;
    }
    return createResourceWithUris(arg, undefined, this.refUri!.clone());
  }

  processBeforeDownload(
    res: Resource,
    element: Cheerio | null,
    parent: Resource | null,
    options: StaticDownloadOptions & HtmlParserOptions = this.options,
    startIndex = 0
  ): AsyncResult<Resource | void> {
    try {
      const hooks = this.lifeCycle.processBeforeDownload;
      for (let index = startIndex; index < hooks.length; index++) {
        const hook = hooks[index];
        const next = hook(res, element, parent, options, this);
        if (isPromiseLike(next)) return (async () => {
          try {
            const resource = await next;
            if (!resource) {
              const disposing = disposeHtmlResource(res);
              if (disposing) await disposing;
              return;
            }
            if (resource !== res) {
              const replacing = this.replaceResource(res, resource);
              if (replacing) await replacing;
            }
            return await this.processBeforeDownload(resource, element, parent, options, index + 1);
          } catch (error) { return disposeOnFailure(res, error); }
        })();
        if (!next) return disposeHtmlResource(res);
        if (next !== res) {
          const replacing = this.replaceResource(res, next);
          if (replacing) return replacing.then(() =>
            this.processBeforeDownload(next, element, parent, options, index + 1));
          res = next;
        }
      }
      if (res.shouldBeDiscardedFromDownload) {
        const disposing = disposeHtmlResource(res);
        if (disposing) return disposing.then(() => res);
      }
      return res;
    } catch (error) { return disposeOnFailure(res, error); }
  }

  async download(
    res: Resource,
    requestOptions: RequestOptions = this.requestOptions,
    options: StaticDownloadOptions & HtmlParserOptions = this.options
  ): Promise<DownloadResource | true | void> {
    let current = res;
    try {
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
      for (const download of this.lifeCycle.download) {
        const downloaded = download(current, requestOptions, options, this);
        const next = isPromiseLike(downloaded) ? await downloaded : downloaded;
        if (!next) {
          const disposing = disposeHtmlResource(current);
          if (disposing) await disposing;
          return;
        }
        if (next !== current) {
          // Streaming/local hooks finish acquisition without a buffered body.
          if (next === true) {
            const disposing = disposeHtmlResource(current);
            if (disposing) await disposing;
            if (current !== res && current.redirectedUrl) res.redirectedUrl = current.redirectedUrl;
            return true;
          }
          const replacing = this.replaceResource(current, next);
          if (replacing) await replacing;
          current = next;
        }
        // An empty body is still a completed download.
        if (current.body !== undefined) return current as DownloadResource;
      }
      const disposing = disposeHtmlResource(current);
      if (disposing) await disposing;
    } catch (error) { return disposeOnFailure(current, error); }
  }

  async processAfterDownload(
    res: DownloadResource,
    submit: SubmitResourceFunc,
    options: StaticDownloadOptions & HtmlParserOptions = this.options
  ): Promise<DownloadResource | void> {
    let current = res;
    try {
      for (const process of this.lifeCycle.processAfterDownload) {
        const processed = process(current, submit, options, this);
        const next = isPromiseLike(processed) ? await processed : processed;
        if (!next) {
          const disposing = disposeHtmlResource(current);
          if (disposing) await disposing;
          return;
        }
        if (next !== current) {
          const replacing = this.replaceResource(current, next);
          if (replacing) await replacing;
          current = next;
        }
      }
      return current;
    } catch (error) { return disposeOnFailure(current, error); }
  }

  async saveToDisk(
    res: DownloadResource,
    options: StaticDownloadOptions & HtmlParserOptions = this.options
  ): Promise<DownloadResource | void> {
    let current = res;
    try {
      if (this.lifeCycle.existingResource && !await this.shouldSaveResource(res)) {
        const disposing = disposeHtmlResource(res);
        if (disposing) await disposing;
        return;
      }
      for (const save of this.lifeCycle.saveToDisk) {
        const saved = save(current, options, this);
        const next = isPromiseLike(saved) ? await saved : saved;
        if (!next) {
          const disposing = disposeHtmlResource(current);
          if (disposing) await disposing;
          return;
        }
        if (next !== current) {
          const replacing = this.replaceResource(current, next);
          if (replacing) await replacing;
          current = next;
        }
      }
      return current;
    } catch (error) { return disposeOnFailure(current, error); }
  }

  /** Transfer a shared document, or release the previous resource's document. */
  replaceResource(previous: Resource, next: Resource): void | Promise<void> {
    try {
      if (previous.meta.doc && previous.meta.doc === next.meta.doc) {
        const pending = previous.meta.statusChanges;
        if (pending?.length) return (async () => {
          try {
            for (let index = 0; index < pending.length; index++) await pending[index];
          } finally {
            previous.meta.statusChanges = undefined;
            if (previous.meta !== next.meta) previous.meta.doc = undefined;
          }
        })().catch(error => disposeOnFailure(next, error));
        if (previous.meta !== next.meta) previous.meta.doc = undefined;
        return;
      }
      const disposing = disposeHtmlResource(previous);
      return disposing?.catch(error => disposeOnFailure(next, error));
    } catch (error) { return disposeOnFailure(next, error); }
  }

  dispose(
    pipeline: PipelineExecutor,
    downloader: DownloaderWithMeta,
    workerInfo?: WorkerInfo,
    workerExitCode?: number
  ): void | Promise<void> {
    const hooks = this.lifeCycle.dispose;
    if (!hooks?.length) return;
    try {
      for (let index = 0; index < hooks.length; index++) {
        const dispose = hooks[index];
        const disposed = dispose(pipeline, downloader, workerInfo, workerExitCode);
        if (isPromiseLike(disposed)) return (async () => {
          await disposed;
          for (++index; index < hooks.length; index++) {
            const dispose = hooks[index];
            const next = dispose(pipeline, downloader, workerInfo, workerExitCode);
            if (isPromiseLike(next)) await next;
          }
        })();
      }
    } catch (error) { return Promise.reject(error); }
  }

  notifyStatusChange(
    res: Resource | RawResource,
    status: ResourceStatus
  ): Promise<void> {
    const listeners = this.lifeCycle.statusChange;
    if (!listeners?.length) return completedStatusChange;
    let pending: Promise<void>[] | undefined;
    for (const listener of listeners) {
      try {
        const result = listener(res, status, this.options, this);
        if (isPromiseLike(result)) (pending ??= []).push(Promise.resolve(result));
      } catch {
        // Every listener runs, including after a synchronous failure.
      }
    }
    if (!pending) return completedStatusChange;
    const notification = Promise.allSettled(pending).then(() => undefined);
    (res.meta.statusChanges ??= []).push(notification);
    return notification;
  }

  async shouldSaveResource(res: Resource, localPath?: string): Promise<boolean> {
    if (!this.lifeCycle.existingResource) return true;
    const existing = await this._checkExistingResource(res, 'saveToDisk', localPath);
    const remoteLastMod = res.meta.headers?.['last-modified'];
    return !(existing?.action === 'skip' || existing?.action === 'skipSave' ||
      existing?.action === 'ifModifiedSince' && remoteLastMod &&
      new Date(remoteLastMod as string) <= existing.stat.mtime);
  }

  private async _checkExistingResource(
    res: Resource, stage: ExistingResourceStage,
    localPath = path.join(res.localRoot ?? this.options.localRoot, decodeURI(res.savePath))
  ): Promise<{action: ExistingResourceAction; stat: Stats} | void> {
    let stat: Stats;
    try { stat = await fs.stat(localPath); } catch { return; }
    if (!stat.isFile()) return;
    return {
      action: this.lifeCycle.existingResource!({res, stage, localPath, stat, options: this.options}),
      stat
    };
  }
}
