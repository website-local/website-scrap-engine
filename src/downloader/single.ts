import {AbstractDownloader} from './main.js';
import {disposeHtmlResource} from '../cheerio.js';
import type {Resource} from '../resource.js';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import type {
  DownloadResource
} from '../life-cycle/types.js';

export class SingleThreadDownloader extends AbstractDownloader {
  constructor(pathToOptions: string,
    overrideOptions?: Partial<StaticDownloadOptions> & { pathToWorker?: string }) {
    super(pathToOptions, overrideOptions);
  }

  protected _internalInit(options: DownloadOptions): Promise<void> {
    if (options.initialUrl) {
      return this.addInitialResource(options.initialUrl);
    } else {
      return this.addInitialResource([]);
    }
  }

  async downloadAndProcessResource(res: Resource): Promise<boolean | void> {
    let owned: Resource = res;
    try {
      let r: DownloadResource | void;
      try {
        r = await this.pipeline.download(res);
        if (!r) {
          await this.pipeline.notifyStatusChange(res, 'download');
          return;
        }
        owned = r;
      } catch (e) {
        this.handleError(e, 'downloading resource', res);
        return false;
      }

      r.discoveredCount = 0;
      try {
        const processedResource: DownloadResource | void =
        await this.pipeline.processAfterDownload(r, this.submit);
        if (processedResource) owned = processedResource;
        if (!processedResource) {
          await this.pipeline.notifyStatusChange(r, 'processAfterDownload');
        } else if (await this.pipeline.saveToDisk(processedResource)) {
          await this.pipeline.notifyStatusChange(r, 'saveToDisk');
        }
        if (processedResource && processedResource.redirectedUrl &&
        processedResource.redirectedUrl !== processedResource.url) {
          res.redirectedUrl = processedResource.redirectedUrl;
        }
      } catch (e) {
        this.handleError(e, 'post-process', res);
        return false;
      } finally {
        r.discoveredCount = undefined;
        owned.discoveredCount = undefined;
      }
    } finally {
      res.downloaded = owned.downloaded;
      res.publishedFiles = owned.publishedFiles;
      res.shouldBeDiscardedFromDownload = owned.shouldBeDiscardedFromDownload;
      const disposing = disposeHtmlResource(owned);
      if (disposing) await disposing;
      if (owned !== res) {
        const original = disposeHtmlResource(res);
        if (original) await original;
      }
    }
  }

}
