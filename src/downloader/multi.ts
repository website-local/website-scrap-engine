import {MessageChannel, Worker} from 'node:worker_threads';
import type {Transferable} from 'node:worker_threads';
import {WorkerPublicationCoordinator} from './worker-publication.js';
import {DiscoveryLimitError} from './discovery.js';
import {BufferReservation} from '../buffer-budget.js';
import type {WorkerChannels} from './worker-channel.js';
import {currentCrawlContext} from '../crawl-context.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {WorkerFactory, WorkerPoolOptions} from './worker-pool.js';
import {WorkerPool} from './worker-pool.js';
import type {WireResource, Resource} from '../resource.js';
import {decodeResourceFromClone, prepareResourceForClone} from '../resource.js';
import type {DownloadWorkerMessage, PendingPromiseWithBody} from './types.js';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import type {DownloadResource} from '../life-cycle/types.js';
import {AbstractDownloader} from './main.js';

export interface MultiThreadDownloaderOptions extends StaticDownloadOptions {
  pathToWorker?: string;
  maxLoad: number;
  workerPool?: WorkerPoolOptions;
}

export class MultiThreadDownloader extends AbstractDownloader {
  private _pool: WorkerPool<WireResource, DownloadWorkerMessage> | undefined;
  private readonly publications = new WorkerPublicationCoordinator(
    (workerId, taskId) => (this._pool?.workingTasks.get(taskId) as PendingPromiseWithBody | undefined)
      ?.workerId === workerId,
    (worker, error) => {
      const info = this._pool?.workers.find(info => info.worker === worker);
      if (info) this._pool?.rejectWorkerTasks(info, error);
    });
  private readonly createWorker: WorkerFactory = (filename, workerOptions = {}) => {
    const channel = new MessageChannel();
    try {
      const data = workerOptions.workerData as Record<string, unknown> & {workerChannels: WorkerChannels};
      const options = {...workerOptions, workerData: {...data,
        workerChannels: {...data.workerChannels, publicationPort: channel.port2}},
      transferList: [...(workerOptions.transferList ?? []), channel.port2]};
      const worker = this._workerFactory ? this._workerFactory(filename, options) : new Worker(filename, options);
      this.publications.attach(worker, channel.port1);
      return worker;
    } catch (error) {
      channel.port1.close();
      channel.port2.close();
      throw error;
    }
  };
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

  protected async _internalInit(options: DownloadOptions): Promise<void> {
    this.signal.throwIfAborted();
    if (options.waitForWorkers) {
      const pool = this.pool;
      const cancelStartup = () => { void pool.dispose().catch(() => undefined); };
      this.signal.addEventListener('abort', cancelStartup, {once: true});
      try { await pool.ready; }
      finally { this.signal.removeEventListener('abort', cancelStartup); }
    }
    return this.addInitialResource(options.initialUrl ?? []);
  }

  private createPool(options: DownloadOptions): WorkerPool<WireResource, DownloadWorkerMessage> {
    this.signal.throwIfAborted();
    let workerCount: number = options.concurrency;
    if (options.workerCount) {
      workerCount = Math.min(options.workerCount, workerCount);
    }
    if (workerCount < 1) {
      workerCount = 1;
    }
    const workerOptions = options as Partial<MultiThreadDownloaderOptions>;
    this._pool = new WorkerPool<WireResource, DownloadWorkerMessage>(workerCount,
      // worker script should be compiled to .js
      // Resolve relative to this module's own URL: the compiled output is ESM,
      // where `__dirname` is undefined. `__dirname` only type-checks here
      // because @types/node declares it as a global; it would throw a
      // ReferenceError at runtime. fileURLToPath(import.meta.url) is the
      // ESM-safe equivalent (same pattern as read-or-copy-local-resource.ts).
      workerOptions.pathToWorker ||
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'worker.js'),
      {pathToOptions: this.pathToOptions, overrideOptions: this._overrideOptions},
      workerOptions.maxLoad || -1,
      this.createWorker,
      workerOptions.workerPool
    );
    for (const info of this.pool.workers) {
      info.worker.addListener('exit',
        exitCode => {
          const disposed = Promise.resolve(this.pipeline.dispose(this.pipeline, this, info, exitCode));
          void disposed.catch(() => undefined);
          this.workerDispose.push(disposed);
        });
    }
    return this._pool;
  }

  get pool(): WorkerPool<WireResource, DownloadWorkerMessage> {
    // Creation is synchronous and one-shot; submitTask waits for worker readiness.
    return this._pool ?? this.createPool(this.options);
  }

  async downloadAndProcessResource(res: Resource): Promise<boolean | void> {
    let r: DownloadResource | void;
    try {
      r = await this.pipeline!.download(res);
      if (!r) {
        await this.pipeline.notifyStatusChange(res, 'download');
        return;
      }
    } catch (e) {
      this.handleError(e, 'downloading resource', res);
      return false;
    }
    const submit = async (body: WireResource, transfers?: Transferable[]): Promise<DownloadWorkerMessage> => {
      let taskId: number | undefined;
      let completed = false;
      try {
        const result = await this.pool.submitTask(body, transfers, id => {
          taskId = id;
          this.publications.register(id, currentCrawlContext() ?? this.context);
        }, worker => { this.publications.assign(taskId!, worker); });
        completed = true;
        return result;
      } finally {
        if (taskId !== undefined) await this.publications.finish(taskId, !completed);
      }
    };
    let msg: DownloadWorkerMessage | void;
    let children: Resource[];
    try {
      const wire = prepareResourceForClone(r);
      if ((ArrayBuffer.isView(r.body) || Buffer.isBuffer(r.body)) &&
        r.body.byteOffset === 0 &&
        r.body.byteLength === r.body.buffer.byteLength &&
        r.body.buffer instanceof ArrayBuffer) {
        // the array buffer view fully owns the underlying ArrayBuffer
        wire.body = r.body.buffer;
        msg = await submit(wire, [wire.body]);
      } else {
        // lets clone and send it.
        msg = await submit(wire);
      }
      if (!Array.isArray(msg.body)) throw new TypeError('Worker result.body must be a resource array');
      if (this.options.maxDiscoveredResources !== undefined &&
        msg.body.length > this.options.maxDiscoveredResources) {
        throw new DiscoveryLimitError(this.options.maxDiscoveredResources, msg.body.length);
      }
      // Validate the whole batch before admitting any children.
      children = msg.body.map(decodeResourceFromClone);
      if (msg.progress !== undefined) {
        if (!msg.progress || !Number.isSafeInteger(msg.progress.publishedFiles) ||
          msg.progress.publishedFiles < 0 || typeof msg.progress.skipped !== 'boolean') {
          throw new TypeError('Worker result.progress is invalid');
        }
        const progress = currentCrawlContext()?.resourceProgress;
        if (progress) {
          progress.publishedFiles += msg.progress.publishedFiles;
          progress.skipped ||= msg.progress.skipped;
        }
      }
      if (msg.redirectedUrl !== undefined && typeof msg.redirectedUrl !== 'string') {
        throw new TypeError('Worker result.redirectedUrl must be a string');
      }
    } catch (e) {
      this.handleError(e, 'submitting resource to worker', res);
      return false;
    }
    if (!msg) {
      await this.pipeline.notifyStatusChange(res, 'processAfterDownload');
      return;
    }
    if (msg.error) {
      this.handleError(msg.error, 'post-process', res);
    }
    const credit = currentCrawlContext()?.bufferAccount;
    children.forEach(resource => this._addProcessedResource(resource,
      credit instanceof BufferReservation ? credit : undefined));
    if (msg.error) return false;
    if (msg.redirectedUrl) {
      res.redirectedUrl = msg.redirectedUrl;
    }
  }

  protected async cancelActiveWork(): Promise<void> {
    await this._pool?.dispose();
  }

  protected async disposeResources(): Promise<void> {
    await this._pool?.dispose();
    const workerDispose = this.workerDispose;
    this.workerDispose = [];
    const results = await Promise.allSettled([this.publications.dispose(), ...workerDispose]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Worker cleanup failed');
  }
}
