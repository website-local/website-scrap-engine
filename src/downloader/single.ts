import {AbstractDownloader} from './main';
import {Resource} from '../resource';
import {StaticDownloadOptions} from '../options';
import {skip} from '../logger/logger';
import {DownloadResource, SubmitResourceFunc} from '../pipeline';

export class SingleThreadDownloader extends AbstractDownloader {
  readonly init: Promise<void>;

  constructor(public pathToOptions: string,
    overrideOptions?: Partial<StaticDownloadOptions> & { pathToWorker?: string }) {
    super(pathToOptions, overrideOptions);
    if (this.options.initialUrl) {
      this.init = this.addInitialResource(this.options.initialUrl);
    } else {
      this.init = Promise.resolve();
    }
  }

  async downloadAndProcessResource(res: Resource): Promise<void> {
    let r: DownloadResource | void;
    try {
      r = await this.pipeline.download(res);
      if (!r) {
        skip.debug('discarded after download', res.url, res.rawUrl, res.refUrl);
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
        skip.warn('skipped downloaded resource', r.url, r.refUrl);
      } else if (await this.pipeline.saveToDisk(processedResource)) {
        skip.warn('downloaded resource not saved', r.url, r.refUrl);
      }
    } catch (e) {
      this.handleError(e, 'post-process', res);
    }
  }

}
