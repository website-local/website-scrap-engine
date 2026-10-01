import {resource, downloader, options, lifeCycle} from 'website-scrap-engine';
import type {Dispatcher} from 'undici';

const res = resource.createResource({type: resource.ResourceType.Binary,
  depth: 0, url: 'https://example.test/file', refUrl: 'https://example.test/', localRoot: 'output'});
res.uri.clone().hash('');
res.refUri.clone();
res.replaceUri.clone();
const host: string = res.host;
const realUndici: 0 extends (1 & Dispatcher) ? false : true = true;
const close: (crawler: downloader.MultiThreadDownloader) => Promise<void> = crawler => crawler.dispose();

const configuration = options.defaultDownloadOptions({...lifeCycle.defaultLifeCycle(),
  maxBufferedBytes: 4096, maxResourceBytes: 1024, maxDiscoveredResources: 16, maxConcurrency: 4});
declare const crawler: downloader.SingleThreadDownloader;
const currentBytes: number = crawler.bufferedBytes;
const peakBytes: number = crawler.peakBufferedBytes;
const outcome: downloader.types.ResourceOutcome | undefined = crawler.outcomes.get(res.url);
const progress: NonNullable<downloader.types.DownloadWorkerMessage['progress']> = {
  publishedFiles: 1, skipped: false
};
const wire: resource.WireResource = resource.prepareResourceForClone(res);

// @ts-expect-error Runtime URI instances cannot cross the wire boundary.
wire.uri = res.uri;
// @ts-expect-error Normalized URI fields are required, not optional.
res.uri = undefined;
if (outcome) {
  // @ts-expect-error Outcome snapshots are readonly.
  outcome.publishedFiles = 1;
}
void host; void realUndici; void close; void configuration;
void currentBytes; void peakBytes; void outcome; void progress;
