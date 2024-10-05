import PQueue from 'p-queue';
import type {HTTPError} from 'got';
import URI from 'urijs';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import {mergeOverrideOptions} from '../options.js';
import type {RawResource, Resource} from '../resource.js';
import {normalizeResource, ResourceType} from '../resource.js';
import {error, notFound, skip} from '../logger/logger.js';
import {importDefaultFromPath} from '../util.js';
import type {DownloaderStats, DownloaderWithMeta} from './types.js';
import {PipelineExecutorImpl} from './pipeline-executor-impl.js';

export abstract class AbstractDownloader implements DownloaderWithMeta {
  readonly queue: PQueue;
  readonly _asyncOptions: Promise<DownloadOptions>;
  readonly _overrideOptions?: Partial<StaticDownloadOptions> & { pathToWorker?: string };
  _options?: DownloadOptions;
  _isInit: boolean;
  _pipeline?: PipelineExecutorImpl;
  _initOptions: Promise<void>;
  readonly downloadedUrl: Set<string> = new Set<string>();
  readonly queuedUrl: Set<string> = new Set<string>();
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
    this.queue = new PQueue();
    this._isInit = false;
    this._initOptions = this._asyncOptions.then(options => {
      options = mergeOverrideOptions(options, this._overrideOptions);
      this._options = options;
      this._pipeline = new PipelineExecutorImpl(options, options.req, options);
      options.configureLogger(options.localRoot, options.logSubDir || '');
      this._isInit = true;
    });
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
    await this._initOptions;
    const pipeline = this.pipeline;
    await pipeline.init(pipeline, this);
    // noinspection DuplicatedCode
    for (let i = 0, l = urlArr.length; i < l; i++) {
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

  protected _addProcessedResource(res: RawResource): boolean | void {
    // noinspection DuplicatedCode
    if (res.depth > this.options.maxDepth) {
      skip.info('skipped max depth', res.url, res.refUrl, res.depth);
      return false;
    }
    let url: string;
    const uri: URI = ((res as Resource)?.uri?.clone() || URI(res.url)).hash('');
    if (this.options.deduplicateStripSearch) {
      url = uri.search('').toString();
    } else {
      url = uri.toString();
    }
    if (this.queuedUrl.has(url)) {
      return false;
    }
    this.queuedUrl.add(url);
    const resource: Resource = normalizeResource(res);
    // cut the call stack
    // noinspection JSIgnoredPromiseFromCall
    this.queue.add(() => new Promise(r => setImmediate(
      () => r(this.downloadAndProcessResource(resource)))));
  }

  abstract downloadAndProcessResource(res: RawResource): Promise<boolean | void>;

  addProcessedResource(res: RawResource): boolean | void {
    try {
      return this._addProcessedResource(res);
    } catch (e) {
      this.handleError(e, 'adding resource', res);
      return false;
    }
  }

  handleError(err: Error | unknown | null, cause: string, resource: RawResource): void {
    // force cast in case of typescript 4.4
    if (err && (err as {name?: string}).name === 'HTTPError' &&
      (err as HTTPError)?.response?.statusCode === 404) {
      notFound.error(resource.url, resource.downloadLink, resource.refUrl);
    } else if (err) {
      error.error(cause, resource.url, resource.downloadLink, resource.refUrl, err);
    } else {
      error.error(cause, resource.url, resource.downloadLink, resource.refUrl);
    }
  }


  get downloadedCount(): number {
    return this.downloadedUrl.size;
  }

  start(): void {
    if (typeof this.options.adjustConcurrencyFunc === 'function') {
      if (this.adjustTimer) {
        clearInterval(this.adjustTimer);
      }
      this.adjustTimer = setInterval(
        () => this.options.adjustConcurrencyFunc?.(this),
        this.options.adjustConcurrencyPeriod || 60000);
    }
    this._initOptions.then(() => {
      this.queue.start();
    });
  }

  stop(): void {
    if (this.adjustTimer) {
      clearInterval(this.adjustTimer);
    }
    this.queue.pause();
  }

  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  async dispose(): Promise<void> {
    this.stop();
    this.queue.clear();
    await this.pipeline?.dispose(this.pipeline, this);
  }

}

