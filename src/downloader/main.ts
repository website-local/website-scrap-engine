import {
  DownloadOptions,
  mergeOverrideOptions,
  StaticDownloadOptions
} from '../options';
import PQueue from 'p-queue';
import {DownloadResource, PipelineExecutor} from '../pipeline';
import {
  normalizeResource,
  RawResource,
  Resource,
  ResourceType
} from '../resource';
import {WorkerPool} from './worker-pool';
import {cpus} from 'os';
import {DownloadWorkerMessage} from './worker';
import path from 'path';
import {error, notFound, skip} from '../logger';
import {HTTPError} from 'got';
import {importDefaultFromPath} from '../util';

export interface DownloaderStats {
  firstPeriodCount: number;
  lastPeriodTotalCount: number;
  currentPeriodCount: number;
  lastPeriodCount: number;
}

export interface DownloaderWithMeta {
  readonly meta: DownloaderStats;
  readonly queue: PQueue;
  readonly options: DownloadOptions;

  getDownloadedCount(): number;
}

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
    if (this.queuedUrl.has(res.url)) {
      return false;
    }
    this.queuedUrl.add(res.url);
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


  getDownloadedCount(): number {
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

export class DownloaderMain extends AbstractDownloader {
  readonly workers: WorkerPool<RawResource, DownloadWorkerMessage>;
  readonly init: Promise<void>;

  constructor(public pathToOptions: string,
    overrideOptions?: Partial<StaticDownloadOptions> & { pathToWorker?: string }) {
    super(pathToOptions, overrideOptions);
    let workerCount: number =
      Math.min(cpus().length - 2, this.options.concurrency);
    if (this.options.workerCount) {
      workerCount = Math.min(this.options.workerCount, workerCount);
    }
    if (workerCount < 1) {
      workerCount = 1;
    }
    this.workers = new WorkerPool<RawResource, DownloadWorkerMessage>(workerCount,
      // worker script should be compiled to .js
      overrideOptions?.pathToWorker || path.resolve(__dirname, 'worker.js'),
      {pathToOptions, overrideOptions}
    );
    if (this.options.initialUrl) {
      this.init = this.addInitialResource(this.options.initialUrl);
    } else {
      this.init = Promise.resolve();
    }
  }

  async downloadAndProcessResource(res: Resource): Promise<boolean | void> {
    let r: DownloadResource | void;
    try {
      r = await this.pipeline.download(res);
      if (!r) {
        skip.debug('discarded after download', res.url, res.rawUrl, res.refUrl);
        return;
      }
    } catch (e) {
      this.handleError(e, 'downloading resource', res);
      return false;
    }
    let msg: DownloadWorkerMessage | void;
    try {
      // DOMException [DataCloneError]: An ArrayBuffer is neutered and could not be cloned.
      if (Buffer.isBuffer(r.body)) {
        r.body = r.body.buffer;
        msg = await this.workers.submitTask(r);
      } else {
        msg = await this.workers.submitTask(r);
      }
    } catch (e) {
      this.handleError(e, 'submitting resource to worker', res);
      return false;
    }
    this.downloadedUrl.add(res.url);
    if (!msg) {
      skip.info('discarded in post-processing',
        res.url, res.rawUrl, res.refUrl);
      return;
    }
    if (msg.error) {
      this.handleError(msg.error, 'post-process', res);
    }
    if (msg.body?.length) {
      const body: RawResource[] = msg.body;
      body.forEach(rawRes => this._addProcessedResource(rawRes));
    }

  }


  async dispose(): Promise<void> {
    await super.dispose();
    await this.workers.dispose();
  }
}
