import {
  DownloadOptions,
  mergeOverrideOptions,
  StaticDownloadOptions
} from '../options';
import PQueue from 'p-queue';
import {
  normalizeResource,
  RawResource,
  Resource,
  ResourceType
} from '../resource';
import {error, notFound, skip} from '../logger/logger';
import {HTTPError} from 'got';
import {importDefaultFromPath} from '../util';
import URI from 'urijs';
import {DownloaderStats, DownloaderWithMeta} from './types';
import {PipelineExecutor} from '../pipeline-executor';

export abstract class AbstractDownloader implements DownloaderWithMeta {
  readonly queue: PQueue;
  readonly pipeline: PipelineExecutor;
  readonly options: DownloadOptions;
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
    this.options = mergeOverrideOptions(importDefaultFromPath(pathToOptions), overrideOptions);
    this.queue = new PQueue({concurrency: this.options.concurrency});
    this.pipeline = new PipelineExecutor(this.options, this.options.req, this.options);
    this.options.configureLogger(this.options.localRoot, this.options.logSubDir || '');
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
    // noinspection DuplicatedCode
    for (let i = 0, l = urlArr.length; i < l; i++) {
      let url: string | void = urlArr[i];
      url = await this.pipeline.linkRedirect(url, null, null);
      if (!url) continue;
      const type: ResourceType | void = await this.pipeline.detectResourceType(
        url, ResourceType.Html, null, null);
      if (!type) continue;
      let r: Resource | void = await this.pipeline.createResource(type, 0, url, url);
      if (!r) continue;
      r = await this.pipeline.processBeforeDownload(r, null, null);
      if (!r) continue;
      if (!r.shouldBeDiscardedFromDownload) {
        await this.addProcessedResource(r);
      }
    }
  }

  protected _addProcessedResource(res: RawResource): Promise<boolean | void> | boolean {
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
    return this.queue.add(() => new Promise(r => setImmediate(
      () => r(this.downloadAndProcessResource(resource)))));
  }

  abstract async downloadAndProcessResource(res: RawResource): Promise<boolean | void>;

  async addProcessedResource(res: RawResource): Promise<boolean | void> {
    try {
      return await this._addProcessedResource(res);
    } catch (e) {
      this.handleError(e, 'downloading or processing', res);
      return false;
    }
  }

  handleError(err: Error | null, cause: string, resource: RawResource): void {
    if (err && err.name === 'HTTPError' &&
      (err as HTTPError)?.response?.statusCode === 404) {
      notFound.error(resource.url, resource.rawUrl, resource.refUrl);
    } else if (err) {
      error.error(cause, resource.url, resource.rawUrl, resource.refUrl, err);
    } else {
      error.error(cause, resource.url, resource.rawUrl, resource.refUrl);
    }
  }


  get downloadedCount(): number {
    return this.downloadedUrl.size;
  }

  start(): void {
    if (typeof this.options.adjustConcurrencyFunc === 'function') {
      setInterval(() => this.options.adjustConcurrencyFunc?.(this),
        this.options.adjustConcurrencyPeriod || 60000);
    }
    this.queue.start();
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
  }

}

