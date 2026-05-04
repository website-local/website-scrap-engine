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

## Installation

```bash
npm install website-scrap-engine
```

Requires Node.js >= 18.17.0.

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
import path from 'path';
import {downloader} from 'website-scrap-engine';

const {SingleThreadDownloader} = downloader;

const d = new SingleThreadDownloader(
  'file://' + path.resolve('my-options.js')
);
d.start();
d.onIdle().then(() => d.dispose());
```

For CPU-intensive workloads, use `MultiThreadDownloader` instead (see [Multi-Thread Processing](#multi-thread-processing)).

You can also pass override options as the second argument to the downloader constructor, which are merged into the options module's export:

```ts
new SingleThreadDownloader('file://' + path.resolve('my-options.js'), {
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
| `redirectFilter(fn)` | processAfterDownload | Rewrite or discard redirect URLs |
| `processHtml(fn)` | processAfterDownload | Transform the parsed HTML (cheerio `$`) |
| `processHtmlAsync(fn)` | processAfterDownload | Async version of `processHtml` |
| `wrapLegacyGenerateSavePath(fn)` | generateSavePath | Adapt an old full save-path generator to the hook array |

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

### Custom Save Paths

Use `lifeCycle.generateSavePath` to transform where resources are written before
the `Resource` object is created. The first hook receives the built-in save path;
each later hook receives the previous hook's output. Return `undefined` to
discard the resource before download.

```ts
const lc = lifeCycle.defaultLifeCycle();

lc.generateSavePath.push((savePath, ctx) => {
  if (ctx.uri.hostname() === 'cdn.example.com') {
    return savePath.replace('cdn.example.com', 'assets');
  }
  return savePath;
});
```

## Architecture

### Pipeline Life Cycle

Resources are processed through a sequential pipeline of hook arrays. Each stage is an array of functions executed in order. Returning `void`/`undefined` from any function discards the resource from that stage onward.

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
3. generateSavePath --> compute/transform the local save path
 |
 v
4. createResource ----> build a Resource with relative replacement paths
 |
 v
5. processBeforeDownload -> filter/modify resources; link replacement in parent happens after this
 |
 v
6. download ----------> fetch resource via HTTP (loop ends early once body is set)
 |
 v
7. processAfterDownload -> parse content, discover child resources via submit() callback
 |
 v
8. saveToDisk --------> write to local filesystem
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
| generateSavePath | none by default - an empty array uses the built-in URL-to-path mapping |
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

- **`Resource`** (`src/resource.ts`) - Central data object carrying URL, save path, replacement path, body, and metadata. `RawResource` is the serializable subset used for cross-thread communication.
- **`PipelineExecutor`** (interface in `src/life-cycle/pipeline-executor.ts`, impl in `src/downloader/pipeline-executor-impl.ts`) - Orchestrates life cycle execution. `createAndProcessResource()` runs stages 1-5 in one call.
- **`AbstractDownloader`** (`src/downloader/main.ts`) - Base class with PQueue-based concurrency, URL deduplication, and the download loop.
- **`SingleThreadDownloader`** (`src/downloader/single.ts`) - Runs all pipeline stages in the main thread.
- **`MultiThreadDownloader`** (`src/downloader/multi.ts`) - Downloads in main thread, sends to worker pool for post-processing.

## Multi-Thread Processing

Use multi-thread processing when post-download work (HTML/CSS parsing, link discovery) is CPU-intensive.

**Main thread:**
- Runs the download queue with PQueue concurrency control
- Executes stages 1-6 (linkRedirect through download)
- Transfers downloaded resources to worker threads
- Receives discovered child resources back and enqueues non-duplicates

**Worker threads:**
- Receive downloaded resources from the main thread
- Execute stages 7-8 (processAfterDownload + saveToDisk)
- Parse HTML/CSS/SVG, discover child resources
- Run stages 1-5 on discovered children to prepare them
- Send prepared child resources back to the main thread as `RawResource[]`

Worker count defaults to `Math.min(concurrency, workerCount)`. The worker pool uses a 2-pass water-fill algorithm to balance tasks across workers by load.

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

## Key Dependencies

- **cheerio** - HTML/SVG parsing and manipulation
- **got** - HTTP client with retry logic
- **p-queue** - Download concurrency control
- **urijs** - URL resolution and path generation
- **srcset** - `srcset` attribute parsing

## License

ISC
