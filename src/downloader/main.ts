import PQueue from 'p-queue';
import URI from '../uri.js';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import {mergeOverrideOptions, selectDownloadHandlers} from '../options.js';
import type {RawResource, Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import {disposeHtmlResource} from '../cheerio.js';
import {skip} from '../logger/logger.js';
import {setLogger} from '../logger/logger.js';
import {createDefaultLogger} from '../logger/default-logger.js';
import {importDefaultFromPath} from '../util.js';
import type {DownloaderStats, DownloaderWithMeta} from './types.js';
import {completedStatusChange, PipelineExecutorImpl} from './pipeline-executor-impl.js';
import type {InitSubmitFunc} from '../life-cycle/types.js';
import {adjust, resetAdjustment} from './adjust-concurrency.js';

export abstract class AbstractDownloader implements DownloaderWithMeta {
  readonly queue: PQueue;
  readonly _asyncOptions: Promise<DownloadOptions>;
  readonly _overrideOptions?: Partial<StaticDownloadOptions> & { pathToWorker?: string };
  _options?: DownloadOptions;
  _isInit: boolean;
  _pipeline?: PipelineExecutorImpl;
  _initOptions: Promise<void>;
  protected _isDisposing = false;
  private _disposePromise?: Promise<void>;
  private _startRequested = false;
  readonly downloadedUrl: Set<string> = new Set<string>();
  readonly queuedUrl: Set<string> = new Set<string>();
  /** Created only when a redirect alias collides with another admission. */
  declare private _retainedRedirectAliases?: Set<string>;
  readonly meta: DownloaderStats = {
    currentPeriodCount: 0,
    firstPeriodCount: 0,
    lastPeriodCount: 0,
    lastPeriodTotalCount: 0
  };
  adjustTimer: ReturnType<typeof setInterval> | void = undefined;

  protected constructor(public pathToOptions: string,
    overrideOptions?: Partial<StaticDownloadOptions> & { pathToWorker?: string }) {
    this._asyncOptions = importDefaultFromPath(pathToOptions);
    this._overrideOptions = overrideOptions;
    // Initial concurrency is replaced after configuration. On p-queue upgrades,
    // check pause/clear/onIdle semantics in p-queue.spec.ts and disposal tests.
    // Queue 9's backlog win hid extra bounded/yielding work; measure those paths
    // and complete crawls before replacing the accepted 8.1.1 baseline.
    this.queue = new PQueue({concurrency: 2});
    this._isInit = false;
    this._initOptions = this._asyncOptions.then(options => {
      options = mergeOverrideOptions(options, this._overrideOptions);
      selectDownloadHandlers(options);
      this._options = options;
      // https://github.com/website-local/website-scrap-engine/issues/1113
      this.queue.concurrency = options.concurrency;
      this._pipeline = new PipelineExecutorImpl(options, options.req, options);
      setLogger((options.createLogger ?? createDefaultLogger)(options));
      const initializing = this._internalInit(options);
      if (initializing) return initializing.then(() => {
        this._isInit = true;
      });
      this._isInit = true;
    });
    void this._initOptions.catch(() => undefined);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected _internalInit(options: DownloadOptions): void | Promise<void> {
  }

  get options(): DownloadOptions {
    if (this._options) {
      return this._options;
    }
    throw new TypeError('AbstractDownloader: not initialized');
  }

  get pipeline(): PipelineExecutorImpl {
    if (this._pipeline) {
      return this._pipeline;
    }
    throw new TypeError('AbstractDownloader: not initialized');
  }

  get concurrency(): number {
    return this.queue.concurrency;
  }

  set concurrency(newConcurrency: number) {
    this.queue.concurrency = newConcurrency;
  }

  get queueSize(): number {
    return this.queue.size;
  }

  get queuePending(): number {
    return this.queue.pending;
  }

  async addInitialResource(urlArr: string[]): Promise<void> {
    if (!this._pipeline) {
      // _initOptions could await addInitialResource
      await this._initOptions;
    }
    const pipeline = this.pipeline;
    if (pipeline.lifeCycle.init?.length) {
      // Init submissions belong to this call, even when downloaders reuse a
      // module's options or the caller supplies a shared initial URL array.
      urlArr = urlArr.slice();
      const submit: InitSubmitFunc = (url: string) => {
        urlArr.push(url);
      };
      const initializing = pipeline.init(pipeline, this, submit);
      if (initializing) await initializing;
    }
    // noinspection DuplicatedCode
    for (let i = 0; i < urlArr.length; i++) {
      let url: string | void = urlArr[i];
      url = await pipeline.linkRedirect(url, null, null);
      if (!url) continue;
      const type: ResourceType | void = await pipeline.detectResourceType(
        url, ResourceType.Html, null, null);
      if (!type) continue;
      let r: Resource | void = await pipeline.createResource(
        type, 0, url, url,
        undefined, undefined, undefined, type);
      if (!r) continue;
      r = await pipeline.processBeforeDownload(r, null, null);
      if (!r) continue;
      if (!r.shouldBeDiscardedFromDownload) {
        this.addProcessedResource(r);
      }
    }
  }

  protected canonicalUrl(url: string, parsed?: URI): string {
    if (parsed && !parsed.hash() &&
      (!this.options.deduplicateStripSearch || !parsed.search())) {
      return parsed.toString();
    }
    const uri = (parsed ? parsed.clone() : URI(url)).hash('');
    if (this.options.deduplicateStripSearch) uri.search('');
    return uri.toString();
  }

  protected retainRedirectAlias(url: string, queuedUrl?: string): void {
    const alias = this.canonicalUrl(url);
    if (alias !== queuedUrl && this.queuedUrl.has(alias)) {
      (this._retainedRedirectAliases ??= new Set<string>()).add(alias);
    }
    this.queuedUrl.add(alias);
  }

  protected releaseFailedAdmission(url: string): void {
    if (!this._retainedRedirectAliases?.has(url)) this.queuedUrl.delete(url);
  }

  protected _addProcessedResource(res: Resource): boolean | void {
    if (this._isDisposing) return false;
    // noinspection DuplicatedCode
    if (res.depth > this.options.maxDepth) {
      skip.info('skipped max depth', res.url, res.refUrl, res.depth);
      this.pipeline.notifyStatusChange(res, 'dispose');
      return false;
    }
    const url = this.canonicalUrl(res.url, res.uri);
    if (this.queuedUrl.has(url)) {
      return false;
    }
    this.queuedUrl.add(url);
    // Reuse admission's key even if a lifecycle hook changes the resource URL.
    void this.queue.add(() => this.downloadAndProcessResource(res, url))
      .catch(error => {
        this.releaseFailedAdmission(url);
        this.handleError(error, 'processing resource', res);
      });
  }

  abstract downloadAndProcessResource(res: Resource, queuedUrl?: string): Promise<boolean | void>;

  /** Submit an already normalized resource from the resource/lifecycle APIs. */
  addProcessedResource(res: Resource): boolean | void {
    try {
      return this._addProcessedResource(res);
    } catch (e) {
      this.handleError(e, 'adding resource', res);
      return false;
    }
  }

  handleError(err: Error | unknown | null, cause: string, resource: RawResource): void {
    resource.meta = resource.meta || {};
    resource.meta['error'] = err;
    resource.meta['errorCause'] = cause;
    this.pipeline.notifyStatusChange(resource, 'error');
  }

  protected disposeResource(resource: Resource): void | Promise<void> {
    return disposeHtmlResource(resource);
  }


  get downloadedCount(): number {
    return this.downloadedUrl.size;
  }

  start(): void {
    this._startRequested = true;
    void this._initOptions.then(() => {
      if (!this._startRequested || this._isDisposing) return;
      if (typeof this.options.adjustConcurrencyFunc === 'function') {
        if (this.adjustTimer) {
          clearInterval(this.adjustTimer);
        }
        if (this.options.adjustConcurrencyFunc === adjust) resetAdjustment(this);
        this.adjustTimer = setInterval(
          () => this.options.adjustConcurrencyFunc?.(this),
          this.options.adjustConcurrencyPeriod || 60000);
      }
      this.queue.start();
    }).catch(() => undefined);
  }

  stop(): void {
    this._startRequested = false;
    if (this.adjustTimer) {
      clearInterval(this.adjustTimer);
      this.adjustTimer = undefined;
    }
    this.queue.pause();
  }

  onIdle(): Promise<void> {
    return this._isInit ? this.queue.onIdle() : this._initOptions.then(() => this.queue.onIdle());
  }

  protected _disposeWorkers(): void | Promise<void> {
    // Only the multiple-thread downloader owns workers.
  }

  dispose(): Promise<void> {
    if (this._disposePromise) return this._disposePromise;
    this._isDisposing = true;
    this.stop();
    if (this.queue.size) this.queue.clear();
    if (this._isInit && !this.queue.pending && !this._pipeline?.lifeCycle.dispose?.length &&
        this._disposeWorkers === AbstractDownloader.prototype._disposeWorkers &&
        this._pipeline?.dispose === PipelineExecutorImpl.prototype.dispose) {
      // An idle ordinary downloader has no remaining work or custom cleanup.
      return this._disposePromise = completedStatusChange;
    }
    this._disposePromise = this.finishDisposal();
    return this._disposePromise;
  }

  private async finishDisposal(): Promise<void> {
    // Publish the shared promise before invoking hooks or overridden cleanup.
    if (this._isInit) await this._initOptions;
    else {
      await this._initOptions.catch(() => undefined);
      if (this.queue.size) this.queue.clear();
    }
    try {
      const disposing = this._disposeWorkers();
      if (disposing) await disposing;
    } finally {
      if (this.queue.pending) await this.queue.onIdle();
      if (this._pipeline) {
        const disposing = this._pipeline.dispose(this._pipeline, this);
        if (disposing) await disposing;
      }
    }
  }

}
