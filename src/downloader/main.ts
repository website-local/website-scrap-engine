import {withCrawlContext, createResourceProgress} from '../crawl-context.js';
import type {CrawlContext} from '../crawl-context.js';
import {OutputDirectories, StagingDirectories} from '../output-store.js';
import {PublicationReservations} from '../publication-reservations.js';
import type { BufferReservation} from '../buffer-budget.js';
import {BufferBudget} from '../buffer-budget.js';
import {checkResourceSize, resourceBodyBytes} from '../resource-limits.js';
import {adjust, resetAdjustment} from './adjust-concurrency.js';
import PQueue from 'p-queue';
import URI from 'urijs';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import {mergeOverrideOptions} from '../options.js';
import type {RawResource, Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import {skip} from '../logger/logger.js';
import {createDefaultLogger} from '../logger/default-logger.js';
import {importDefaultFromPath} from '../util.js';
import type {DownloaderStats, DownloaderWithMeta, ResourceOutcome} from './types.js';
import {completedStatusChange, PipelineExecutorImpl} from './pipeline-executor-impl.js';
import type {InitSubmitFunc, ResourceStatus} from '../life-cycle/types.js';

export type DownloaderState = 'initializing' | 'ready' | 'running' |
  'paused' | 'closing' | 'closed' | 'failed';

export interface DisposeOptions {
  /** Default: cancel accepted work and await cleanup. */
  drain?: boolean;
}

export abstract class AbstractDownloader implements DownloaderWithMeta {
  readonly queue: PQueue;
  private _state: DownloaderState = 'initializing';
  private _closing?: Promise<void>;
  private _startGeneration = 0;
  private _admittedCount = 0;
  private bufferBudget?: BufferBudget;
  get bufferedBytes(): number { return this.bufferBudget?.used ?? 0; }
  get peakBufferedBytes(): number { return this.bufferBudget?.peak ?? 0; }
  private readonly resourceOutcomes = new Map<string, ResourceOutcome>();
  get outcomes(): ReadonlyMap<string, ResourceOutcome> { return this.resourceOutcomes; }
  private readonly notifications = new Set<Promise<void>>();
  protected readonly abortController = new AbortController();
  protected context: CrawlContext = {
    logger: createDefaultLogger(), signal: this.abortController.signal,
    publicationReservations: new PublicationReservations(),
    stagingDirectories: new StagingDirectories()
  };

  get state(): DownloaderState { return this._state; }
  get signal(): AbortSignal { return this.abortController.signal; }
  readonly _asyncOptions: Promise<DownloadOptions>;
  readonly _overrideOptions?: Partial<StaticDownloadOptions> & { pathToWorker?: string };
  _options?: DownloadOptions;
  _isInit: boolean;
  _pipeline?: PipelineExecutorImpl;
  _initOptions: Promise<void>;
  readonly downloadedUrl: Set<string> = new Set<string>();
  readonly queuedUrl: Set<string> = new Set<string>();
  // Alias retention is independent of an in-flight reservation. A failing
  // request must not release another successful request's redirect target.
  private readonly retainedAliases = new Set<string>();

  private canonicalUrl(url: string, parsed?: URI): string {
    if (parsed && !parsed.hash() && (!this.options.deduplicateStripSearch || !parsed.search())) {
      return parsed.toString();
    }
    const uri = (parsed ? parsed.clone() : new URI(url)).hash('');
    if (this.options.deduplicateStripSearch) uri.search('');
    return uri.toString();
  }

  protected retainRedirectAlias(url: string, parsed?: URI): void {
    const key = this.canonicalUrl(url, parsed);
    this.retainedAliases.add(key);
    this.queuedUrl.add(key);
  }

  private releaseFailedReservation(url: string): void {
    if (!this.retainedAliases.has(url)) this.queuedUrl.delete(url);
  }
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
    // A safeguard here, concurrency is set later
    this.queue = new PQueue({concurrency: 2, autoStart: false});
    this._isInit = false;
    this._initOptions = this._asyncOptions.then(options => {
      options = mergeOverrideOptions(options, this._overrideOptions);
      this._options = options;
      this.context.directWrites = options.atomicWrites !== true;
      if (!options.strictOutputChecks) this.context.outputDirectories = new OutputDirectories();
      if (options.maxBufferedBytes !== undefined) this.bufferBudget = new BufferBudget(options.maxBufferedBytes);
      // https://github.com/website-local/website-scrap-engine/issues/1113
      this.queue.concurrency = options.concurrency;
      this._pipeline = new PipelineExecutorImpl(options, options.req, options, this.signal);
      this.context.logger = (options.createLogger ?? createDefaultLogger)(options);
      return withCrawlContext(this.context, () => this._internalInit(options)).then(() => {
        this._isInit = true;
        if (this._state === 'initializing') this._state = 'ready';
      });
    }).catch(error => {
      if (this._state !== 'closing' && this._state !== 'closed') this._state = 'failed';
      throw error;
    });
    // Preserve rejection for callers while avoiding an unhandled rejection when
    // they choose to dispose a downloader whose initialization failed.
    void this._initOptions.catch(() => undefined);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected _internalInit(options: DownloadOptions): Promise<void> {
    return Promise.resolve();
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
    if (!Number.isSafeInteger(newConcurrency) || newConcurrency < 1) {
      throw new RangeError('concurrency must be a positive safe integer');
    }
    this.queue.concurrency = Math.min(newConcurrency, this._options?.maxConcurrency ?? Infinity);
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
    urlArr = urlArr.slice();
    const pipeline = this.pipeline;
    const submit: InitSubmitFunc = (url: string) => {
      urlArr.push(url);
    };
    await pipeline.init(pipeline, this, submit);
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

  protected _addProcessedResource(res: Resource, credit?: BufferReservation): boolean | void {
    if (this._state === 'closing' || this._state === 'closed' || this.signal.aborted) {
      return false;
    }
    // noinspection DuplicatedCode
    if (res.depth > this.options.maxDepth) {
      skip.info('skipped max depth', res.url, res.refUrl, res.depth);
      this.notifyStatus(res, 'dispose');
      return false;
    }
    const resource = res;
    const resourceLimit = this.options.maxResourceBytes;
    const checkedBytes = resourceLimit === undefined || resource.body === undefined ? undefined :
      resourceBodyBytes(resource.body, resource.encoding);
    if (checkedBytes !== undefined) checkResourceSize(checkedBytes, resourceLimit);
    const url = this.canonicalUrl(resource.url, resource.uri);
    if (this.queuedUrl.has(url)) {
      return false;
    }
    const limit = this.options.maxResources !== undefined &&
      this._admittedCount >= this.options.maxResources ? 'maxResources' :
      this.options.maxQueuedResources !== undefined &&
      this.queue.size >= this.options.maxQueuedResources ? 'maxQueuedResources' : undefined;
    if (limit) {
      this.handleError(Object.assign(new Error(`Crawl admission limit exceeded: ${limit}`),
        {code: 'ERR_CRAWL_LIMIT', limit}), 'admitting resource', resource);
      return false;
    }
    const bytes = this.bufferBudget ? checkedBytes ?? resourceBodyBytes(resource.body, resource.encoding) : 0;
    const bufferReservation = this.bufferBudget ? credit && credit.childBytes >= bytes ? credit.takeChild(bytes) :
      this.bufferBudget.reserve(bytes) : undefined;
    delete resource.meta.error;
    delete resource.meta.errorCause;
    ++this._admittedCount;
    this.queuedUrl.add(url);
    const progress = createResourceProgress();
    const attempt = (this.resourceOutcomes.get(url)?.attempt ?? 0) + 1;
    const admittedUrl = resource.url;
    const record = (status: ResourceOutcome['status']) => this.resourceOutcomes.set(url,
      Object.freeze({status, attempt, url: admittedUrl, downloaded: progress.downloaded,
        publishedFiles: progress.publishedFiles}));
    record('queued');
    void this.queue.add(() => withCrawlContext({...this.context, resourceProgress: progress,
      publicationOwner: url, bufferAccount: bufferReservation}, async () => {
      let succeeded = false;
      record('running');
      try {
        this.signal.throwIfAborted();
        succeeded = await this.downloadAndProcessResource(resource) !== false;
        if (!succeeded) this.releaseFailedReservation(url);
        else {
          this.signal.throwIfAborted();
          if (progress.downloaded && resource.redirectedUrl) {
            this.retainRedirectAlias(resource.redirectedUrl,
              resource.uri.toString() === resource.redirectedUrl ? resource.uri : undefined);
          }
        }
      } catch (error) {
        succeeded = false;
        this.releaseFailedReservation(url);
        throw error;
      } finally {
        bufferReservation?.release();
        let status: ResourceOutcome['status'];
        if (this.signal.aborted) status = 'cancelled';
        else if (!succeeded) status = 'failed';
        else if (progress.publishedFiles) status = 'saved';
        else if (!progress.downloaded || progress.skipped) status = 'skipped';
        else status = 'processed';
        if (status !== 'failed' && status !== 'cancelled' && progress.downloaded) {
          this.downloadedUrl.add(admittedUrl);
        }
        if (status === 'cancelled') this.releaseFailedReservation(url);
        record(status);
      }
    })).catch(error => {
      this.handleError(error, this.signal.aborted ? 'cancelled' : 'processing resource', resource);
    });
    return true;
  }

  abstract downloadAndProcessResource(res: Resource): Promise<boolean | void>;

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
    this.notifyStatus(resource, 'error');
  }


  private notifyStatus(resource: RawResource, status: ResourceStatus): void {
    const result = withCrawlContext(this.context, () =>
      this._pipeline?.notifyStatusChange(resource, status));
    if (!result || result === completedStatusChange) return;
    const pending = Promise.resolve(result);
    this.notifications.add(pending);
    const settled = () => { this.notifications.delete(pending); };
    void pending.then(settled, settled);
  }

  get downloadedCount(): number {
    return this.downloadedUrl.size;
  }

  async start(): Promise<void> {
    const generation = ++this._startGeneration;
    await this._initOptions;
    if (this._state === 'closing' || this._state === 'closed') {
      throw new Error('Downloader is closing or closed');
    }
    if (generation !== this._startGeneration) return;
    this._state = 'running';
    withCrawlContext(this.context, () => {
      if (typeof this.options.adjustConcurrencyFunc === 'function') {
        if (this.adjustTimer) clearInterval(this.adjustTimer);
        if (this.options.adjustConcurrencyFunc === adjust) resetAdjustment(this);
        this.adjustTimer = setInterval(
          () => this.options.adjustConcurrencyFunc?.(this),
          this.options.adjustConcurrencyPeriod || 60000);
        this.adjustTimer.unref();
      }
      this.queue.start();
    });
  }

  stop(): void {
    ++this._startGeneration;
    if (this.adjustTimer) clearInterval(this.adjustTimer);
    this.adjustTimer = undefined;
    this.queue.pause();
    if (this._state === 'running' || this._state === 'ready') this._state = 'paused';
  }

  onIdle(): Promise<void> {
    return this._initOptions.then(() => this.queue.onIdle());
  }

  /** Release subclass resources; called once after accepted work has settled. */
  protected async disposeResources(): Promise<void> {}

  /** Cancel subclass tasks that cannot observe the main-thread AbortSignal. */
  protected async cancelActiveWork(): Promise<void> {}

  dispose(options: DisposeOptions = {}): Promise<void> {
    if (this._closing) return this._closing;
    this.stop();
    this._state = 'closing';
    if (!options.drain) this.abortController.abort(new Error('Downloader disposed'));
    this._closing = withCrawlContext(this.context, async () => {
      const errors: unknown[] = [];
      try { await this._initOptions; } catch { /* Clean up partial initialization. */ }
      if (!options.drain) {
        try { await this.cancelActiveWork(); } catch (error) { errors.push(error); }
      }
      // Do not clear PQueue: clear() leaves its accepted task promises unsettled.
      // Cancelled tasks enter their wrapper, observe the signal, and do no I/O.
      this.queue.start();
      await this.queue.onIdle();
      await Promise.all(this.notifications);
      try { await this.disposeResources(); } catch (error) { errors.push(error); }
      try {
        await this._pipeline?.dispose(this._pipeline, this);
      } catch (error) { errors.push(error); }
      this._state = 'closed';
      if (errors.length) throw new AggregateError(errors, 'Downloader cleanup failed');
    });
    return this._closing;
  }
}
