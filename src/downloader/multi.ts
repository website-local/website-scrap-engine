import path from 'path';
import {WorkerPool} from './worker-pool';
import type {RawResource, Resource} from '../resource';
import type {DownloadWorkerMessage} from './types';
import type {StaticDownloadOptions} from '../options';
import type {DownloadResource} from '../life-cycle/types';
import {skip} from '../logger/logger';
import {AbstractDownloader} from './main';

export interface MultiThreadDownloaderOptions extends StaticDownloadOptions {
  pathToWorker?: string;
  maxLoad: number;
}

export class MultiThreadDownloader extends AbstractDownloader {
  readonly workers: WorkerPool<RawResource, DownloadWorkerMessage>;
  readonly init: Promise<void>;

  constructor(
    public pathToOptions: string,
    overrideOptions?: Partial<MultiThreadDownloaderOptions>
  ) {
    super(pathToOptions, overrideOptions);
    let workerCount: number = this.options.concurrency;
    if (this.options.workerCount) {
      workerCount = Math.min(this.options.workerCount, workerCount);
    }
    if (workerCount < 1) {
      workerCount = 1;
    }
    this.workers = new WorkerPool<RawResource, DownloadWorkerMessage>(workerCount,
      // worker script should be compiled to .js
      overrideOptions?.pathToWorker || path.resolve(__dirname, 'worker.js'),
      {pathToOptions, overrideOptions},
      overrideOptions?.maxLoad || -1
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
      if ((ArrayBuffer.isView(r.body) || Buffer.isBuffer(r.body)) &&
        r.body.byteOffset === 0 &&
        r.body.byteLength === r.body.buffer.byteLength) {
        // the array buffer view fully owns the underlying ArrayBuffer
        r.body = r.body.buffer;
        msg = await this.workers.submitTask(r, [r.body]);
      } else {
        // lets clone and send it.
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
    await this.workers.dispose();
  }
}
