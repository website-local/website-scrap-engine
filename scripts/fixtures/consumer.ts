import {resource, downloader, options, lifeCycle, URI, NativeUri} from 'website-scrap-engine';
import type {Dispatcher} from 'undici';

const res = resource.createResource({type: resource.ResourceType.Binary,
  depth: 0, url: 'https://example.test/file', refUrl: 'https://example.test/', localRoot: 'output'});
res.uri.clone().hash('');
res.refUri.clone();
res.replaceUri.clone();
const host: string = res.host;
const compatibleUri: URI = URI('../asset.svg').absoluteTo('https://example.test/docs/');
const nativeUri: NativeUri = new URI(compatibleUri).clone().filename('other.svg');
const query: string = nativeUri.query();
const fromParts = URI({protocol: 'https', hostname: 'example.test', path: '/a'}, compatibleUri);
fromParts.query(data => { data.flag = null; }).addSearch('x', [1, 2]).removeQuery('x', /1/);
const parsedQuery = fromParts.search(true);
const hasValue: boolean = fromParts.hasQuery('x', '2', true);
const decodedSegment: string | undefined = fromParts.segmentCoded(0);
const built: string = URI.buildQuery(parsedQuery);
const encodedSegment: string = URI.encodePathSegment('a/b');
const encodedParameter: string = URI.buildQueryParameter('flag', null);
const observedText: string = URI.withinString('https://example.test/', () => {});
void encodedSegment; void encodedParameter; void observedText;
void hasValue; void decodedSegment; void built;
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
void compatibleUri; void nativeUri; void query;
