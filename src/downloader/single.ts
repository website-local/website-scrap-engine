import {AbstractDownloader} from './main.js';
import {completedStatusChange} from './pipeline-executor-impl.js';
import type {Resource} from '../resource.js';
import {copyResourceBody} from '../resource.js';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import type {
  DownloadResource,
  SubmitResourceFunc
} from '../life-cycle/types.js';

export class SingleThreadDownloader extends AbstractDownloader {
  readonly init: Promise<void>;
  private readonly _submit: SubmitResourceFunc = (resources: Resource | Resource[]) => {
    if (Array.isArray(resources)) {
      for (let i = 0; i < resources.length; i++) this._submit(resources[i]);
    } else {
      const body = resources.body;
      this._addProcessedResource(body !== undefined && typeof body !== 'string' ?
        {...resources, body: copyResourceBody(body)} : resources);
    }
  };

  constructor(public pathToOptions: string,
    overrideOptions?: Partial<StaticDownloadOptions> & { pathToWorker?: string }) {
    super(pathToOptions, overrideOptions);
    this.init = this._initOptions;
  }

  protected _internalInit(options: DownloadOptions): void | Promise<void> {
    if (options.initialUrl?.length || options.init.length) {
      return this.addInitialResource(options.initialUrl || []);
    }
  }

  async downloadAndProcessResource(res: Resource, queuedUrl?: string): Promise<void> {
    let r: DownloadResource | void = undefined;
    let processedResource: DownloadResource | void = undefined;
    let savedResource: DownloadResource | void = undefined;
    let stage = 'downloading resource';
    try {
      try {
        const downloaded = await this.pipeline.download(res);
        if (downloaded !== res && (!downloaded || downloaded === true)) {
          const notification = this.pipeline.notifyStatusChange(res, 'download');
          if (notification !== completedStatusChange) await notification;
          if (!downloaded) return;
          // true completes acquisition without a body for subsequent processing.
        } else {
          r = downloaded;
          stage = 'post-process';
          processedResource = await this.pipeline.processAfterDownload(r, this._submit);
          if (!processedResource) {
            const notification = this.pipeline.notifyStatusChange(r, 'processAfterDownload');
            if (notification !== completedStatusChange) await notification;
          } else {
            savedResource = await this.pipeline.saveToDisk(processedResource);
            if (savedResource) {
              const notification = this.pipeline.notifyStatusChange(savedResource, 'saveToDisk');
              if (notification !== completedStatusChange) await notification;
            }
          }
        }
      } catch (error) {
        if (queuedUrl !== undefined) {
          this.releaseFailedAdmission(queuedUrl);
          queuedUrl = undefined;
        }
        this.handleError(error, stage, res);
        return;
      } finally {
        // Error observers may append status work which ownership cleanup drains.
        try {
          if (savedResource && savedResource !== processedResource && savedResource !== r && savedResource !== res) {
            const disposing = this.disposeResource(savedResource);
            if (disposing) await disposing;
          }
        } finally {
          try {
            if (processedResource && processedResource !== r && processedResource !== res) {
              const disposing = this.disposeResource(processedResource);
              if (disposing) await disposing;
            }
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
        }
      }
      const result = savedResource || processedResource || (r ? undefined : res);
      if (result?.redirectedUrl && result.redirectedUrl !== result.url) {
        this.retainRedirectAlias(result.redirectedUrl, queuedUrl);
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
      return;
    }
    this.downloadedUrl.add(res.url);
  }

}
