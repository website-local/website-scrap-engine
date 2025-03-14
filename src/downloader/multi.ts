import path from 'node:path';
import type {WorkerFactory} from './worker-pool.js';
import {WorkerPool} from './worker-pool.js';
import type {RawResource, Resource} from '../resource.js';
import type {DownloadWorkerMessage} from './types.js';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import type {DownloadResource} from '../life-cycle/types.js';
import {skip} from '../logger/logger.js';
import {AbstractDownloader} from './main.js';

export interface MultiThreadDownloaderOptions extends StaticDownloadOptions {
  pathToWorker?: string;
  maxLoad: number;
}

export class MultiThreadDownloader extends AbstractDownloader {
  private _pool: WorkerPool<RawResource, DownloadWorkerMessage> | undefined;
  readonly init: Promise<void>;
  workerDispose: Promise<void>[];

  constructor(
    public pathToOptions: string,
    overrideOptions?: Partial<MultiThreadDownloaderOptions>,
    private _workerFactory?: WorkerFactory
  ) {
    super(pathToOptions, overrideOptions);
    this.init = this._initOptions;
    this.workerDispose = [];
  }

  protected _internalInit(options: DownloadOptions): Promise<void> {
    let workerCount: number = options.concurrency;
    if (options.workerCount) {
      workerCount = Math.min(options.workerCount, workerCount);
    }
    if (workerCount < 1) {
      workerCount = 1;
    }
    const overrideOptions = options as Partial<MultiThreadDownloaderOptions>;
    this._pool = new WorkerPool<RawResource, DownloadWorkerMessage>(workerCount,
      // worker script should be compiled to .js
      overrideOptions?.pathToWorker || path.resolve(__dirname, 'worker.js'),
      {pathToOptions: this.pathToOptions, overrideOptions},
      overrideOptions?.maxLoad || -1,
      this._workerFactory
    );
    for (const info of this.pool.workers) {
      info.worker.addListener('exit',
        exitCode => this.workerDispose.push(
          this.pipeline.dispose(this.pipeline, this, info, exitCode)));
    }
    if (this.options.initialUrl) {
      return this.addInitialResource(this.options.initialUrl);
    } else {
      return this._initOptions.then(() => this.pipeline.init(this.pipeline, this));
    }
  }

  get pool(): WorkerPool<RawResource, DownloadWorkerMessage> {
    if (this._pool) {
      return this._pool;
    }
    throw new TypeError('MultiThreadDownloader: pool not initialized');
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

  async dispose(): Promise<void> {
    await super.dispose();
    await this.pool.dispose();
    const workerDispose = this.workerDispose;
    this.workerDispose = [];
    await Promise.all(workerDispose);
  }
}
