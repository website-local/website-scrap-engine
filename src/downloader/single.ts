import {AbstractDownloader} from './main.js';
import type {Resource} from '../resource.js';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import type {
  DownloadResource,
  SubmitResourceFunc
} from '../life-cycle/types.js';

export class SingleThreadDownloader extends AbstractDownloader {
  readonly init: Promise<void>;

  constructor(public pathToOptions: string,
    overrideOptions?: Partial<StaticDownloadOptions> & { pathToWorker?: string }) {
    super(pathToOptions, overrideOptions);
    this.init = this._initOptions;
  }

  protected _internalInit(options: DownloadOptions): Promise<void> {
    if (options.initialUrl) {
      return this.addInitialResource(options.initialUrl);
    } else {
      return this.pipeline.init(this.pipeline, this);
    }
  }

  async downloadAndProcessResource(res: Resource): Promise<void> {
    let r: DownloadResource | void;
    try {
      r = await this.pipeline.download(res);
      if (!r) {
        await this.pipeline.notifyStatusChange(res, 'download');
        return;
      }
    } catch (e) {
      this.handleError(e, 'downloading resource', res);
      return;
    }
    this.downloadedUrl.add(res.url);

    const submit: SubmitResourceFunc = (resources: Resource | Resource[]) => {
      if (Array.isArray(resources)) {
        for (let i = 0; i < resources.length; i++) {
          this._addProcessedResource(resources[i]);
        }
      } else {
        this._addProcessedResource(resources);
      }
    };
    try {
      const processedResource: DownloadResource | void =
        await this.pipeline.processAfterDownload(r, submit);
      if (!processedResource) {
        await this.pipeline.notifyStatusChange(r, 'processAfterDownload');
      } else if (await this.pipeline.saveToDisk(processedResource)) {
        await this.pipeline.notifyStatusChange(r, 'saveToDisk');
      }
      if (processedResource && processedResource.redirectedUrl &&
        processedResource.redirectedUrl !== processedResource.url) {
        this.queuedUrl.add(processedResource.redirectedUrl);
      }
    } catch (e) {
      this.handleError(e, 'post-process', res);
    }
  }

}
