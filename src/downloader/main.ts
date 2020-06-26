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

export class DownloaderMain implements DownloaderWithMeta {
  readonly queue: PQueue;
  readonly pipeline: PipelineExecutor;
  readonly options: DownloadOptions;
  readonly workers: WorkerPool<RawResource, DownloadWorkerMessage>;
  readonly queuedUrl: Set<string> = new Set<string>();
  readonly downloadedUrl: Set<string> = new Set<string>();
  readonly meta: DownloaderStats = {
    currentPeriodCount: 0,
    firstPeriodCount: 0,
    lastPeriodCount: 0,
    lastPeriodTotalCount: 0
  };
  adjustTimer: ReturnType<typeof setInterval> | void = undefined;

  constructor(public pathToOptions: string,
    overrideOptions?: Partial<StaticDownloadOptions> & {pathToWorker?: string}) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    this.options = mergeOverrideOptions(require(pathToOptions), overrideOptions);
    this.queue = new PQueue({concurrency: this.options.concurrency});
    this.pipeline = new PipelineExecutor(this.options, this.options.req, this.options);
    let workerCount: number =
      Math.min(cpus().length - 2, this.options.concurrency);
    if (this.options.workerCount) {
      workerCount = Math.min(this.options.workerCount, workerCount);
    }
    if (workerCount < 1) {
      workerCount = 1;
    }
    this.workers = new WorkerPool<RawResource, DownloadWorkerMessage>(workerCount,
      overrideOptions?.pathToWorker || path.resolve(__dirname, 'worker'),
      {pathToOptions, overrideOptions}
    );
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
      await this.addProcessedResource(r);
    }
  }

  async addProcessedResource(res: RawResource): Promise<boolean | void> {
    if (res.depth > this.options.maxDepth) {
      skip.info('skipped max depth', res.url, res.refUrl, res.depth);
      return false;
    }
    if (this.queuedUrl.has(res.url)) {
      return false;
    }
    this.queuedUrl.add(res.url);
    const resource = normalizeResource(res);
    let r: DownloadResource | void;
    try {
      r = await this.queue.add(() => this.pipeline.download(resource));
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
      if (r.body instanceof ArrayBuffer || Buffer.isBuffer(r.body)) {
        msg = await this.workers.submitTask(r, [r.body]);
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
      // cut the call stack
      setImmediate(() => body.forEach(rawRes => this.addProcessedResource(rawRes)));
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
    if (this.adjustTimer) {
      clearInterval(this.adjustTimer);
    }
    this.queue.pause();
    this.queue.clear();
    await this.workers.dispose();
  }
}
