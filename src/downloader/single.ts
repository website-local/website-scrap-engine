import {AbstractDownloader} from './main';
import {normalizeResource, RawResource, Resource} from '../resource';
import {StaticDownloadOptions} from '../options';
import {error, skip} from '../logger';
import {DownloadResource, SubmitResourceFunc} from '../pipeline';

export class SingleThreadDownloader extends AbstractDownloader {
  readonly queuedUrl: Set<string> = new Set<string>();

  constructor(public pathToOptions: string,
    overrideOptions?: Partial<StaticDownloadOptions> & { pathToWorker?: string }) {
    super(pathToOptions, overrideOptions);
    if (this.options.initialUrl) {
      this.addInitialResource(this.options.initialUrl)
        .catch(e => error.error('add initial url', e));
    }
  }

  async downloadAndProcess(res: Resource): Promise<void> {
    let r: DownloadResource | void;
    try {
      r = await this.queue.add(() => this.pipeline.download(res));
      if (!r) {
        skip.debug('discarded after download', res.url, res.rawUrl, res.refUrl);
        return;
      }
    } catch (e) {
      this.handleError(e, 'downloading resource', res);
      return;
    }

    const collectedResource: RawResource[] = [];
    const submit: SubmitResourceFunc = (resources: Resource | Resource[]) => {
      if (Array.isArray(resources)) {
        for (let i = 0; i < resources.length; i++) {
          collectedResource.push((resources[i]));
        }
      } else {
        collectedResource.push((resources));
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
    if (collectedResource.length) {
      setImmediate(() => collectedResource.forEach(
        resource => this.addProcessedResource(resource)));
    }
  }

  async addProcessedResource(res: RawResource): Promise<boolean | void> {
    if (res.depth > this.options.maxDepth) {
      skip.info('skipped max depth', res.url, res.refUrl, res.depth);
      return false;
    }
    if (this.queuedUrl.has(res.url)) {
      return false;
    }
    this.queuedUrl.add(res.url);
    return this.queue.add(() => this.downloadAndProcess(normalizeResource(res)));
  }

}
