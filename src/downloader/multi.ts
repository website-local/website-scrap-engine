import path from 'node:path';
import type {WorkerFactory} from './worker-pool.js';
import {WorkerPool} from './worker-pool.js';
import type {RawResource, Resource} from '../resource.js';
import type {DownloadWorkerMessage} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {DownloadResource} from '../life-cycle/types.js';
import {skip} from '../logger/logger.js';
import {AbstractDownloader} from './main.js';

export interface MultiThreadDownloaderOptions extends StaticDownloadOptions {
  pathToWorker?: string;
  maxLoad: number;
}

export class MultiThreadDownloader extends AbstractDownloader {
  readonly pool: WorkerPool<RawResource, DownloadWorkerMessage>;
  readonly init: Promise<void>;
  workerDispose: Promise<void>[];

  constructor(
    public pathToOptions: string,
    overrideOptions?: Partial<MultiThreadDownloaderOptions>,
    workerFactory?: WorkerFactory
  ) {
    super(pathToOptions, overrideOptions);
    let workerCount: number = this.options.concurrency;
    if (this.options.workerCount) {
      workerCount = Math.min(this.options.workerCount, workerCount);
    }
    if (workerCount < 1) {
      workerCount = 1;
    }
    this.pool = new WorkerPool<RawResource, DownloadWorkerMessage>(workerCount,
      // worker script should be compiled to .js
      overrideOptions?.pathToWorker || path.resolve(__dirname, 'worker.js'),
      {pathToOptions, overrideOptions},
      overrideOptions?.maxLoad || -1,
      workerFactory
    );
    this.workerDispose = [];
    for (const info of this.pool.workers) {
      info.worker.addListener('exit',
        exitCode => this.workerDispose.push(
          this.pipeline.dispose(this.pipeline, this, info, exitCode)));
    }
    if (this.options.initialUrl) {
      this.init = this.addInitialResource(this.options.initialUrl);
    } else {
      this.init = this._initOptions.then(() => this.pipeline.init(this.pipeline, this));
    }
  }

  async downloadAndProcessResource(res: Resource): Promise<boolean | void> {
    let r: DownloadResource | void;
    try {
      r = await this.pipeline!.download(res);
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
      if ((ArrayBuffer.isView(r.body) || Buffer.isBuffer(r.body)) &&
        r.body.byteOffset === 0 &&
        r.body.byteLength === r.body.buffer.byteLength) {
        // the array buffer view fully owns the underlying ArrayBuffer
        r.body = r.body.buffer;
        msg = await this.pool.submitTask(r, [r.body]);
      } else {
        // lets clone and send it.
        msg = await this.pool.submitTask(r);
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
    if (msg.redirectedUrl) {
      this.queuedUrl.add(msg.redirectedUrl);
    }

  }

  onIdle(): Promise<void> {
    if (this.options.waitForInitBeforeIdle) {
      return this.init.then(() => super.onIdle());
    }
    return super.onIdle();
  }

  async dispose(): Promise<void> {
    await super.dispose();
    await this.pool.dispose();
    const workerDispose = this.workerDispose;
    this.workerDispose = [];
    await Promise.all(workerDispose);
  }
}
