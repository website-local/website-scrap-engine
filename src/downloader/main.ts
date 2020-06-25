import {DownloadOptions} from '../options';
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
import {error, skip} from '../logger';

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

  constructor(public pathToOptions: string) {
    this.options = require(pathToOptions);
    this.queue = new PQueue({concurrency: this.options.concurrency});
    this.pipeline = new PipelineExecutor(this.options, this.options.req, this.options);
    this.workers = new WorkerPool<RawResource, DownloadWorkerMessage>(
      Math.max(1,
        Math.min(cpus().length - 2,
          this.options.concurrency,
          this.options.workerCount)),
      path.resolve(__dirname, 'worker'),
      {pathToOptions}
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
      error.error('Error downloading resource', res.url, res.rawUrl, res.refUrl, e);
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
      error.error('Error submitting resource to worker',
        res.url, res.rawUrl, res.refUrl, e);
      return false;
    }
    this.downloadedUrl.add(res.url);
    if (!msg) {
      skip.info('discarded in post-processing',
        res.url, res.rawUrl, res.refUrl);
      return;
    }
    if (msg.error) {
      error.error('Error post-processing resource',
        res.url, res.rawUrl, res.refUrl, msg.error);
    }
    if (msg.body?.length) {
      const body: RawResource[] = msg.body;
      // cut the call stack
      setImmediate(() => body.forEach(rawRes => this.addProcessedResource(rawRes)));
    }
  }

  getDownloadedCount(): number {
    return this.downloadedUrl.size;
  }

  start(): void {
    this.queue.start();
  }

  stop(): void {
    this.queue.pause();
  }

  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  async dispose(): Promise<void> {
    this.queue.pause();
    this.queue.clear();
    await this.workers.dispose();
  }
}
