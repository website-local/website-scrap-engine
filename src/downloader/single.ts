import {AbstractDownloader} from './main.js';
import {createDiscoverySubmit} from './discovery.js';
import {withResourceHtmlParser, trackHtmlResource} from '../cheerio.js';
import type {Resource} from '../resource.js';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import type {
  DownloadResource
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
      return this.addInitialResource([]);
    }
  }

  downloadAndProcessResource(res: Resource): Promise<boolean | void> {
    return withResourceHtmlParser(this.options, () => this.processResource(res));
  }

  private async processResource(res: Resource): Promise<boolean | void> {
    trackHtmlResource(res);
    let r: DownloadResource | void;
    try {
      r = await this.pipeline.download(res);
      if (!r) {
        await this.pipeline.notifyStatusChange(res, 'download');
        return;
      }
      trackHtmlResource(r);
    } catch (e) {
      this.handleError(e, 'downloading resource', res);
      return false;
    }

    const discovery = createDiscoverySubmit(resource => { this._addProcessedResource(resource); },
      this.signal, this.options.maxDiscoveredResources, this.options.maxResourceBytes);
    try {
      const processedResource: DownloadResource | void =
        await this.pipeline.processAfterDownload(r, discovery.submit);
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
    } finally { discovery.close(); }
  }

}
