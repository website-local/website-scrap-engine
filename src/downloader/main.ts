import {disposeHtmlResource} from '../cheerio.js';
import type {Logger} from '../logger/types.js';
import {createFilePublication, OutputDirectories, StagingDirectories} from '../output-store.js';
import type {FilePublication} from '../output-store.js';
import {checkResourceSize, resourceBodyBytes} from '../resource-limits.js';
import {adjust, resetAdjustment} from './adjust-concurrency.js';
import PQueue from 'p-queue';
import URI from '../uri.js';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import {mergeOverrideOptions} from '../options.js';
import type {RawResource, Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import {createDefaultLogger} from '../logger/default-logger.js';
import {importDefaultFromPath} from '../util.js';
import type {DownloaderStats, DownloaderWithMeta, ResourceOutcome} from './types.js';
import {completedStatusChange, PipelineExecutorImpl} from './pipeline-executor-impl.js';
import type {InitSubmitFunc, ResourceStatus, SubmitResourceFunc} from '../life-cycle/types.js';

export type DownloaderState = 'initializing' | 'ready' | 'running' |
  'paused' | 'closing' | 'closed' | 'failed';

export interface DisposeOptions {
  /** Default: cancel accepted work and await cleanup. */
  drain?: boolean;
}

export abstract class AbstractDownloader implements DownloaderWithMeta {
  readonly queue: PQueue;
  _state: DownloaderState = 'initializing';
  _closing?: Promise<void>;
  _startGeneration = 0;
  _admittedCount = 0;
  readonly resourceOutcomes = new Map<string, ResourceOutcome>();
  get outcomes(): ReadonlyMap<string, ResourceOutcome> { return this.resourceOutcomes; }
  readonly notifications = new Set<Promise<void>>();
  protected readonly abortController = new AbortController();
  logger: Logger = createDefaultLogger();
  outputDirectories?: OutputDirectories;
  readonly stagingDirectories = new StagingDirectories();
  readonly outputReservations: Record<string, {owner: string; active: number; published: boolean}> = {};
  /** One handler per downloader; no closure or pending array per parent. */
  readonly submit: SubmitResourceFunc = (resources, parent) => {
    if (Array.isArray(resources)) {
      for (const resource of resources) this.submit(resource, parent, this.pipeline);
      return;
    }
    this.signal.throwIfAborted();
    const count = parent.discoveredCount;
    if (count === undefined) throw new Error('Resource discovery is closed for this parent');
    parent.discoveredCount = count + 1;
    const limit = this.options.maxDiscoveredResources;
    if (limit !== undefined && count >= limit) {
      resources.shouldBeDiscardedFromDownload = true;
      this.logger.warn('system.skip', 'Resource exceeds maxDiscoveredResources', resources.url, count + 1, limit);
      this.notifyStatus(resources, 'dispose');
      return;
    }
    this._addProcessedResource(resources);
  };

  get state(): DownloaderState { return this._state; }
  get signal(): AbortSignal { return this.abortController.signal; }
  readonly _overrideOptions?: Partial<StaticDownloadOptions> & { pathToWorker?: string };
  _options?: DownloadOptions;
  _pipeline?: PipelineExecutorImpl;
  readonly init: Promise<void>;
  readonly downloadedUrl: Set<string> = new Set<string>();
  readonly queuedUrl: Set<string> = new Set<string>();
  // Alias retention is independent of an in-flight reservation. A failing
  // request must not release another successful request's redirect target.
  readonly retainedAliases = new Set<string>();

  canonicalUrl(url: string, parsed?: URI): string {
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

  releaseFailedReservation(url: string): void {
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
    this._overrideOptions = overrideOptions;
    // A safeguard here, concurrency is set later
    this.queue = new PQueue({concurrency: 2, autoStart: false});
    this.init = importDefaultFromPath<DownloadOptions>(pathToOptions).then(options => {
      options = mergeOverrideOptions(options, this._overrideOptions);
      this._options = options;
      if (!options.strictOutputChecks) this.outputDirectories = new OutputDirectories();
      // https://github.com/website-local/website-scrap-engine/issues/1113
      this.queue.concurrency = options.concurrency;
      this.logger = (options.createLogger ?? createDefaultLogger)(options);
      this._pipeline = new PipelineExecutorImpl(options, options.req, options, this.signal, this.logger, this);
      return this._internalInit(options).then(() => {
        if (this._state === 'initializing') this._state = 'ready';
      });
    }).catch(error => {
      if (this._state !== 'closing' && this._state !== 'closed') this._state = 'failed';
      throw error;
    });
    // Preserve rejection for callers while avoiding an unhandled rejection when
    // they choose to dispose a downloader whose initialization failed.
    void this.init.catch(() => undefined);
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
      // Initialization may itself await addInitialResource.
      await this.init;
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

  protected _addProcessedResource(res: Resource): boolean | void {
    if (this._state === 'closing' || this._state === 'closed' || this.signal.aborted) {
      return false;
    }
    // noinspection DuplicatedCode
    if (res.depth > this.options.maxDepth) {
      this.logger.info('system.skip', 'skipped max depth', res.url, res.refUrl, res.depth);
      this.notifyStatus(res, 'dispose');
      return false;
    }
    const resource = res;
    const resourceLimit = this.options.maxResourceBytes;
    const checkedBytes = resourceLimit === undefined || resource.body === undefined ? undefined :
      resourceBodyBytes(resource.body, resource.encoding);
    if (checkedBytes !== undefined && !checkResourceSize(checkedBytes, resourceLimit, resource, this.logger)) {
      this.notifyStatus(resource, 'dispose');
      return false;
    }
    const url = this.canonicalUrl(resource.url, resource.uri);
    if (this.queuedUrl.has(url)) {
      // Re-submitting the accepted object must not dispose its active document.
      if (!resource.publicationOwner) this.notifyStatus(resource, 'dispose');
      return false;
    }
    const limit = this.options.maxResources !== undefined &&
      this._admittedCount >= this.options.maxResources ? 'maxResources' :
      this.options.maxQueuedResources !== undefined &&
      this.queue.size >= this.options.maxQueuedResources ? 'maxQueuedResources' : undefined;
    if (limit) {
      resource.shouldBeDiscardedFromDownload = true;
      this.logger.warn('system.skip', 'Crawl admission limit exceeded', limit, resource.url);
      this.notifyStatus(resource, 'dispose');
      return false;
    }
    delete resource.meta.error;
    delete resource.meta.errorCause;
    ++this._admittedCount;
    this.queuedUrl.add(url);
    resource.publicationOwner = url;
    resource.downloaded = false;
    resource.publishedFiles = 0;
    resource.shouldBeDiscardedFromDownload = false;
    const attempt = (this.resourceOutcomes.get(url)?.attempt ?? 0) + 1;
    const admittedUrl = resource.url;
    const record = (status: ResourceOutcome['status']) => this.resourceOutcomes.set(url,
      Object.freeze({status, attempt, url: admittedUrl, downloaded: !!resource.downloaded,
        publishedFiles: resource.publishedFiles ?? 0}));
    record('queued');
    void this.queue.add(async () => {
      let succeeded = false;
      record('running');
      try {
        this.signal.throwIfAborted();
        succeeded = await this.downloadAndProcessResource(resource) !== false;
        if (!succeeded) this.releaseFailedReservation(url);
        else {
          this.signal.throwIfAborted();
          if (resource.downloaded && resource.redirectedUrl) {
            this.retainRedirectAlias(resource.redirectedUrl,
              resource.uri.toString() === resource.redirectedUrl ? resource.uri : undefined);
          }
        }
      } catch (error) {
        succeeded = false;
        this.releaseFailedReservation(url);
        throw error;
      } finally {
        let status: ResourceOutcome['status'];
        if (this.signal.aborted) status = 'cancelled';
        else if (!succeeded) status = 'failed';
        else if (resource.publishedFiles) status = 'saved';
        else if (!resource.downloaded || resource.shouldBeDiscardedFromDownload) status = 'skipped';
        else status = 'processed';
        if (status !== 'failed' && status !== 'cancelled' && resource.downloaded) {
          this.downloadedUrl.add(admittedUrl);
        }
        if (status === 'cancelled') this.releaseFailedReservation(url);
        record(status);
      }
    }).catch(error => {
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


  notifyStatus(resource: RawResource, status: ResourceStatus): void {
    const pipeline = this._pipeline;
    if (!pipeline) return;
    const result = pipeline.notifyStatusChange(resource, status);
    const cleanup = result === completedStatusChange ? disposeHtmlResource(resource) :
      result.then(() => disposeHtmlResource(resource));
    if (!cleanup) return;
    const pending = cleanup;
    this.notifications.add(pending);
    const settled = () => { this.notifications.delete(pending); };
    void pending.then(settled, settled);
  }

  claimOutput(destination: string, owner: string): void {
    let reservation = this.outputReservations[destination];
    if (reservation && reservation.owner !== owner) {
      throw Object.assign(new Error('Output destination is already owned by ' + reservation.owner + ': ' + destination),
        {code: 'ERR_OUTPUT_CONFLICT', destination, owner: reservation.owner});
    }
    if (!reservation) this.outputReservations[destination] = reservation = {owner, active: 0, published: false};
    ++reservation.active;
  }

  create(destination: string, signal?: AbortSignal, localRoot?: string,
    writerRejectsSymlinks = false, resource?: Resource): Promise<FilePublication> {
    return createFilePublication(destination, signal, localRoot, writerRejectsSymlinks, resource, this);
  }

  releaseOutput(destination: string, published: boolean): void {
    const reservation = this.outputReservations[destination];
    reservation.published ||= published;
    if (--reservation.active === 0 && !reservation.published) delete this.outputReservations[destination];
  }

  get downloadedCount(): number {
    return this.downloadedUrl.size;
  }

  async start(): Promise<void> {
    const generation = ++this._startGeneration;
    await this.init;
    if (this._state === 'closing' || this._state === 'closed') {
      throw new Error('Downloader is closing or closed');
    }
    if (generation !== this._startGeneration) return;
    this._state = 'running';
    if (typeof this.options.adjustConcurrencyFunc === 'function') {
      if (this.adjustTimer) clearInterval(this.adjustTimer);
      if (this.options.adjustConcurrencyFunc === adjust) resetAdjustment(this);
      this.adjustTimer = setInterval(
        () => this.options.adjustConcurrencyFunc?.(this, this.logger),
        this.options.adjustConcurrencyPeriod || 60000);
      this.adjustTimer.unref();
    }
    this.queue.start();
  }

  stop(): void {
    ++this._startGeneration;
    if (this.adjustTimer) clearInterval(this.adjustTimer);
    this.adjustTimer = undefined;
    this.queue.pause();
    if (this._state === 'running' || this._state === 'ready') this._state = 'paused';
  }

  onIdle(): Promise<void> {
    return this.init.then(() => this.queue.onIdle());
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
    this._closing = this.close(options);
    return this._closing;
  }

  async close(options: DisposeOptions): Promise<void> {
    const errors: unknown[] = [];
    try { await this.init; } catch { /* Clean up partial initialization. */ }
    if (!options.drain) {
      try { await this.cancelActiveWork(); } catch (error) { errors.push(error); }
    }
    // Do not clear PQueue: clear() leaves its accepted task promises unsettled.
    // Cancelled tasks enter their wrapper, observe the signal, and do no I/O.
    this.queue.start();
    await this.queue.onIdle();
    // A failed notification must not interrupt worker/pipeline cleanup.
    while (this.notifications.size) {
      for (const result of await Promise.allSettled(this.notifications)) {
        if (result.status === 'rejected') errors.push(result.reason);
      }
    }
    try { await this.disposeResources(); } catch (error) { errors.push(error); }
    try {
      await this._pipeline?.dispose(this._pipeline, this);
    } catch (error) { errors.push(error); }
    this._state = 'closed';
    if (errors.length) throw new AggregateError(errors, 'Downloader cleanup failed');
  }
}
