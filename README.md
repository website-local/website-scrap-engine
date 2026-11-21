# website-scrap-engine

Configurable website scraper library in TypeScript. Consumers provide a `DownloadOptions` config (which includes a `ProcessingLifeCycle`) and instantiate a downloader to recursively scrape websites to local disk.

## Features

- Configurable processing pipeline with hook arrays at every stage
- Single-thread and multi-thread (native `worker_threads`) downloaders
- HTML, CSS, SVG, and sitemap parsing with automatic link discovery
- CSS `url()` extraction and rewriting
- `srcset`, Open Graph meta tags, inline styles, and SVG `xlink:href` support
- Automatic URL-to-relative-path rewriting so saved sites work offline
- Streaming download support for large binary resources
- PQueue-based concurrency with runtime adjustment
- URL deduplication with configurable search-param stripping
- Configurable retry with exponential backoff, jitter, and `Retry-After` header support
- Local `file://` source support for re-processing previously saved sites
- Pluggable logging with dedicated categories (`skip`, `retry`, `error`, `notFound`, etc.)
- Native URL resolution with the exported `URI` compatibility API
- Application-selected GroveDOM through a synchronous `loadHtml` callback
- Optional native HTTP(S) transport with bounded retries and Got fallback

0.10 is unreleased. It retains 0.9.1's crawl and worker architecture with native
URL and the applicable performance improvements. See the [project rules](docs/0.10-design.md#development-rules-and-validation-tools):
default performance regressions are forbidden; costly features must have zero
overhead when disabled.

## Installation

```bash
npm install website-scrap-engine
```

Requires Node.js 22.13.0 or newer. `npm test` runs lint, strict source/test types,
and Jest. Use `npm run check:tests` for the type check alone.

See the [migration guide](docs/MIGRATION-0.10.0.md), [documentation index](docs/README.md),
and [GroveDOM guide](docs/grovedom.md). Cheerio remains the default parser.

An optional [Got error-formatter preload](docs/0.10-design.md#optional-got-formatter-preload)
reduces unused native memory while preserving validation errors. For a built
0.10 package, enable it before the application starts:

```bash
node --import website-scrap-engine/lib/got-error-formatters.js app.mjs
```

It is disabled by default because startup timing remains unqualified. It needs
to run before Got's type checker is loaded; normal Node workers inherit the
preload. No dependency patch or permanent global replacement is needed.

## Usage

The downloader takes a path (or `file://` URL) to a module that default-exports a `DownloadOptions` object. This pattern allows worker threads to independently load the same configuration.

**Step 1: Create an options module** (e.g. `my-options.js`)

```ts
import {lifeCycle, options, resource} from 'website-scrap-engine';

const {defaultLifeCycle} = lifeCycle;
const {defaultDownloadOptions} = options;
const {ResourceType} = resource;

const lc = defaultLifeCycle();

// Example: skip binary resources deeper than depth 2
lc.processBeforeDownload.push((res) => {
  if (res.depth > 2 && res.type === ResourceType.Binary) return;
  return res;
});

export default defaultDownloadOptions({
  ...lc,
  localRoot: '/path/to/save',
  maxDepth: 3,
  initialUrl: ['https://example.com'],
});
```

**Step 2: Create and run the downloader**

```ts
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {downloader} from 'website-scrap-engine';

const {SingleThreadDownloader} = downloader;

const d = new SingleThreadDownloader(
  pathToFileURL(path.resolve('my-options.js')).href
);
try {
  await d.init;
  d.start();
  await d.onIdle();
} finally {
  await d.dispose();
}
```

For CPU-intensive workloads, use `MultiThreadDownloader` instead (see [Multi-Thread Processing](#multi-thread-processing)).

You can also pass override options as the second argument to the downloader constructor, which are merged into the options module's export:

```ts
new SingleThreadDownloader(pathToFileURL(path.resolve('my-options.js')).href, {
  localRoot: '/different/path',
  concurrency: 8,
});
```

### Adapter Helpers

The library provides adapter functions in `lifeCycle.adapter` for common customization patterns:

| Adapter | Stage | Description |
|---|---|---|
| `skipProcess(fn)` | linkRedirect | Skip URLs matching a predicate |
| `dropResource(fn)` | processBeforeDownload | Mark matching resources as discard-only (replace link but don't download) |
| `preProcess(fn)` | processBeforeDownload | Inspect/modify resources before download |
| `requestRedirect(fn)` | processBeforeDownload | Rewrite the download URL |
| `localUrlMounts(mounts)` | download | Read matched HTTP(S) URL prefixes from local directories before HTTP fallback |
| `redirectFilter(fn)` | processAfterDownload | Rewrite or discard redirect URLs |
| `processHtml(fn)` | processAfterDownload | Transform the parsed HTML (cheerio `$`) |
| `processHtmlAsync(fn)` | processAfterDownload | Async version of `processHtml` |

```ts
import {lifeCycle} from 'website-scrap-engine';

const lc = lifeCycle.defaultLifeCycle();

// Skip all URLs containing "/api/"
lc.linkRedirect.push(lifeCycle.adapter.skipProcess(
  (url) => url.includes('/api/')
));

// Drop images from download but still rewrite their links
lc.processBeforeDownload.push(lifeCycle.adapter.dropResource(
  (res) => res.type === ResourceType.Binary && res.url.endsWith('.png')
));
```

### Local URL Mounts

Use `lifeCycle.adapter.localUrlMounts()` to mount static local directories over
HTTP(S) URL prefixes during the download stage. Add it before
`downloadResource` so local hits short-circuit network fetches while misses can
fall back to HTTP.

```ts
const lc = lifeCycle.defaultLifeCycle();

lc.download.unshift(lifeCycle.adapter.localUrlMounts([
  {
    root: '/mnt/e/example-overlay',
    urlPrefix: 'https://example.com/assets/',
    priority: 10,
    notFound: 'fallback',
  },
]));
```

Matching is static prefix routing: higher `priority` wins, and equal priority
uses the longest URL prefix. For dynamic routing, regexp matching, or custom
overlay logic, use a lifecycle function to rewrite `res.downloadLink` before
download. Mounted source directories must not overlap the scrape output path;
that aliasing is undefined behavior and is not checked.

### Custom Save Paths

Assign the optional `lifeCycle.generateSavePath` callback to customize the full
save path. It receives the resolved URI, HTML flag, query-preservation flag, and
local source root. The callback also generates the parent path when the caller
does not supply `refSavePath`.

```ts
import {resource} from 'website-scrap-engine';

const lc = lifeCycle.defaultLifeCycle();

lc.generateSavePath = (uri, isHtml, keepSearch, localSrcRoot) => {
  const savePath = resource.generateSavePath(
    uri, isHtml, keepSearch, localSrcRoot);
  return uri.hostname() === 'cdn.example.com' ?
    savePath.replace('cdn.example.com', 'assets') : savePath;
};
```

Direct callers can pass the same callback as `createResource({generateSavePathFn,
...})`. Use `dropResource()` or a `processBeforeDownload` hook to discard a resource.

Save paths must resolve inside `localRoot` when resources are written. The
built-in HTTP(S) mapping sanitizes literal and encoded `.` / `..` path segments;
custom callbacks should return relative paths within the configured output
directory.

## Architecture

### Pipeline Life Cycle

Most pipeline stages are arrays of hooks executed in order. `createResource` is a single callback that returns a `Resource`. Returning `void`/`undefined` from a resource-processing hook stops processing that resource for the stage.

```
init (once per downloader/worker startup)
 |
 v
URL
 |
 v
1. linkRedirect -----> skip or redirect URLs before processing
 |
 v
2. detectResourceType -> determine type (Html, Css, Binary, Svg, SiteMap, etc.)
 |
 v
3. createResource ----> build a Resource using the optional save-path callback
 |
 v
4. processBeforeDownload -> filter/modify resources; link replacement in parent happens after this
 |
 v
5. download ----------> fetch resource via HTTP (loop ends early once body is set)
 |
 v
6. processAfterDownload -> parse content, discover child resources via submit() callback
 |
 v
7. saveToDisk --------> write to local filesystem
 |
 v
dispose (once per downloader shutdown / worker exit)
```

Consumers extend the pipeline by prepending or appending functions to any stage array via `defaultLifeCycle()`. See [Usage](#usage) for examples.

### Default Pipeline Handlers

| Stage | Default handlers |
|---|---|
| linkRedirect | `skipLinks` - filters out non-HTTP URI schemes (mailto, javascript, data, etc.) |
| detectResourceType | `detectResourceType` - infers type from element/context |
| createResource | `createResource` - builds Resource with resolved URL, save path, and replace path |
| download | `downloadResource`, `downloadStreamingResource`, `readOrCopyLocalResource` |
| processAfterDownload | `processRedirectedUrl`, `processHtml`, `processHtmlMetaRefresh`, `processSvg`, `processCss`, `processSiteMap` |
| saveToDisk | `saveHtmlToDisk`, `saveResourceToDisk` |

### Resource Types

Defined in `ResourceType` enum:

| Type | Encoding | Description |
|---|---|---|
| `Binary` | null | Not parsed, saved as-is |
| `Html` | utf8 | Parsed with cheerio, links discovered and rewritten |
| `Css` | utf8 | CSS `url()` references extracted and rewritten |
| `CssInline` | utf8 | Inline `<style>` blocks and `style` attributes |
| `SiteMap` | utf8 | URLs discovered but not rewritten |
| `Svg` | utf8 | Parsed with cheerio (same as HTML) |
| `StreamingBinary` | null | Streamed directly to disk, for large files |

### HTML Source Definitions

The scraper discovers linked resources from HTML using configurable source definitions. The defaults cover:

- Images: `img[src]`, `img[srcset]`, `picture source[srcset]`
- Styles: `link[rel="stylesheet"]`, `<style>` blocks, `[style]` attributes
- Scripts: `script[src]`
- Links: `a[href]`, `frame[src]`, `iframe[src]`
- Media: `video[src]`, `video[poster]`, `audio[src]`, `source[src]`, `track[src]`
- SVG: `*[xlink:href]`, `*[href]`
- Meta: `meta[property="og:image"]`, `og:audio`, `og:video` and their variants
- Other: `embed[src]`, `object[data]`, `input[src]`, `[background]`, `link[rel*="icon"]`, `link[rel*="preload"]`

Override via `options.sources` with an array of `{selector, attr, type}` definitions.

### Key Abstractions

- **`Resource`** (`src/resource.ts`) - Carries normalized native URI objects, paths, body and metadata. `WireResource` omits URI instances, parsed documents and status promises; `postMessage` clones its metadata at dispatch.
- **`PipelineExecutor`** (interface in `src/life-cycle/pipeline-executor.ts`, impl in `src/downloader/pipeline-executor-impl.ts`) - Orchestrates life cycle execution. `createAndProcessResource()` runs stages 1-4 in one call.
- **`AbstractDownloader`** (`src/downloader/main.ts`) - Base class with PQueue-based concurrency, URL deduplication, and the download loop.
- **`SingleThreadDownloader`** (`src/downloader/single.ts`) - Runs all pipeline stages in the main thread.
- **`MultiThreadDownloader`** (`src/downloader/multi.ts`) - Downloads in main thread, sends to worker pool for post-processing.

## Multi-Thread Processing

Use multi-thread processing when post-download work (HTML/CSS parsing, link discovery) is CPU-intensive.

**Main thread:**
- Runs the download queue with PQueue concurrency control
- Executes stages 1-5 (linkRedirect through download)
- Transfers downloaded resources to worker threads
- Receives discovered child resources back and enqueues non-duplicates

**Worker threads:**
- Receive downloaded resources from the main thread
- Execute stages 6-7 (processAfterDownload + saveToDisk)
- Parse HTML/CSS/SVG, discover child resources
- Run stages 1-4 on discovered children to prepare them
- Send prepared child resources back to the main thread as `WireResource[]`

Worker count defaults to `Math.min(concurrency, workerCount)`. The worker pool uses a 2-pass water-fill algorithm to balance tasks across workers by load.

Pools start on the first processing task and remain available until disposal.
Streaming-only crawls do not start processing workers. Completion counts break
equal-load ties, so repeated small batches use all workers. Dispatch is batched.
Workers write files directly. Failures may leave partial files; applications
control output collisions and publication policies.

Custom workers receive tasks on `parentPort` and send completion and log messages
on the same port. Completion messages use `WorkerMessageType.Complete`; log
messages use `WorkerMessageType.Log`. `WorkerPool.onMessage()` dispatches them,
and `workingTasks` remains a record indexed by task ID. Custom worker factories
continue to receive `workerData` without requiring transferred message ports.

## Logging

The library exposes dedicated logger categories through a pluggable logger
interface. The default logger writes to `console`; a log4js adapter is available
for file-based logging.

| Logger | Purpose |
|---|---|
| `skip` | Resources filtered/discarded at any pipeline stage |
| `skipExternal` | External resources skipped by scope |
| `retry` | HTTP retry attempts with backoff details |
| `error` | Download and processing errors |
| `notFound` | 404 responses |
| `request` / `response` | HTTP request/response logging |
| `complete` | Successfully processed resources |
| `mkdir` | Directory creation |
| `adjustConcurrency` | Runtime concurrency changes |

Configure logging via `options.createLogger` and `options.logSubDir`.
Install `log4js` explicitly when using its optional file-logging adapter. Logger
factories declaring `workerSafe: true` run locally in each worker; other worker
logs are forwarded to the parent. The logger remains shared within each thread.

## Key Dependencies

- **cheerio** - HTML/SVG parsing and manipulation
- **got** - HTTP client with retry logic
- **p-queue** - Download concurrency control
- **Node URL** - URL resolution through the exported `URI` compatibility wrapper
- **srcset** - `srcset` attribute parsing

## License

ISC
