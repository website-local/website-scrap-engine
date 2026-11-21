import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {WorkerFactory} from './worker-pool.js';
import {WorkerPool} from './worker-pool.js';
import type {Resource, WireResource} from '../resource.js';
import {decodeResourceFromClone, prepareResourceForClone} from '../resource.js';
import {getLogger} from '../logger/logger.js';
import type {DownloadWorkerMessage} from './types.js';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import type {DownloadResource} from '../life-cycle/types.js';
import {AbstractDownloader} from './main.js';
import {completedStatusChange} from './pipeline-executor-impl.js';

export interface MultiThreadDownloaderOptions extends StaticDownloadOptions {
  pathToWorker?: string;
  maxLoad: number;
}

export class MultiThreadDownloader extends AbstractDownloader {
  private _pool: WorkerPool<WireResource, DownloadWorkerMessage> | undefined;
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

  protected _internalInit(options: DownloadOptions): void | Promise<void> {
    if (options.initialUrl?.length || options.init.length) {
      return this.addInitialResource(options.initialUrl || []);
    }
  }

  get pool(): WorkerPool<WireResource, DownloadWorkerMessage> {
    if (this._pool) return this._pool;
    if (this._isDisposing) throw new Error('disposed');
    const options = this.options;
    let workerCount: number = options.concurrency;
    if (options.workerCount) {
      workerCount = Math.min(options.workerCount, workerCount);
    }
    if (workerCount < 1) {
      workerCount = 1;
    }
    const workerOptions = options as Partial<MultiThreadDownloaderOptions>;
    this._pool = new WorkerPool<WireResource, DownloadWorkerMessage>(workerCount,
      // Resolve the emitted worker next to this ESM module.
      workerOptions.pathToWorker ||
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'worker.js'),
      {pathToOptions: this.pathToOptions, overrideOptions: this._overrideOptions,
        useWorkerLogger: getLogger().workerSafe === true},
      workerOptions.maxLoad || -1,
      this._workerFactory
    );
    for (const info of this._pool.workers) {
      info.worker.on('exit', exitCode => {
        const disposing = this.pipeline.dispose(this.pipeline, this, info, exitCode);
        if (disposing) {
          void disposing.catch(() => undefined);
          this.workerDispose.push(disposing);
        }
      });
    }
    return this._pool;
  }

  async downloadAndProcessResource(res: Resource, queuedUrl?: string): Promise<boolean | void> {
    let r: DownloadResource | void = undefined;
    let msg: DownloadWorkerMessage | undefined;
    let stage = 'downloading resource';
    try {
      try {
        const downloaded = await this.pipeline.download(res);
        if (downloaded !== res && (!downloaded || downloaded === true)) {
          const notification = this.pipeline.notifyStatusChange(res, 'download');
          if (notification !== completedStatusChange) await notification;
          if (!downloaded) return;
          // true completes acquisition without starting a processing worker.
        } else {
          r = downloaded;
          stage = 'submitting resource to worker';
          const wire = prepareResourceForClone(r);
          const body = r.body;
          if (ArrayBuffer.isView(body) && body.byteOffset === 0 &&
            body.byteLength === body.buffer.byteLength && body.buffer instanceof ArrayBuffer) {
            // Transfer the owned buffer without replacing the source resource's wrapper.
            wire.body = body.buffer;
            msg = await this.pool.submitTask(wire, [body.buffer]);
          } else if (body instanceof ArrayBuffer) {
            msg = await this.pool.submitTask(wire, [body]);
          } else {
            msg = await this.pool.submitTask(wire);
          }
          stage = 'post-process';
          if (msg.body?.length) {
            for (const child of msg.body) this._addProcessedResource(decodeResourceFromClone(child));
          }
          if (msg.error) throw msg.error;
        }
      } catch (error) {
        if (queuedUrl !== undefined) {
          this.releaseFailedAdmission(queuedUrl);
          queuedUrl = undefined;
        }
        this.handleError(error, stage, res);
        return false;
      } finally {
        try {
          if (r && r !== res) {
            const disposing = this.disposeResource(r);
            if (disposing) await disposing;
          }
        } finally {
          const disposing = this.disposeResource(res);
          if (disposing) await disposing;
        }
      }
      const redirectedUrl = r ? msg?.redirectedUrl : res.redirectedUrl;
      if (redirectedUrl && redirectedUrl !== res.url) {
        this.retainRedirectAlias(redirectedUrl, queuedUrl);
      }
    } catch (e) {
      if (queuedUrl !== undefined) {
        this.releaseFailedAdmission(queuedUrl);
      }
      this.handleError(e, stage, res);
      try {
        const disposing = this.disposeResource(res);
        if (disposing) await disposing;
      } catch (cleanupError) {
        // Never release a newer admission if an error observer's cleanup fails.
        res.meta.error = new AggregateError([e, cleanupError], 'Resource cleanup failed', {cause: cleanupError});
      }
      return false;
    }
    this.downloadedUrl.add(res.url);
  }

  protected _disposeWorkers(): void | Promise<void> {
    if (!this._pool && !this.workerDispose.length) return;
    return (async () => {
      if (this._pool) await this._pool.dispose();
      const workerDispose = this.workerDispose;
      this.workerDispose = [];
      if (workerDispose.length) await Promise.all(workerDispose);
    })();
  }
}
