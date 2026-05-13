0.10.0
============

**BREAKING CHANGE** — see Breaking Changes below.

Feature
------------
* **life-cycle: add local URL mount download adapter** — New `lifeCycle.adapter.localUrlMounts()` / `lifeCycle.localUrlMounts()` helper mounts static local directories over HTTP(S) URL prefixes during the download lifecycle, with priority/longest-prefix matching, HTML index resolution, case handling, and configurable miss behavior.
* **life-cycle: add generateSavePath stage (#731)** — New `generateSavePath` hook array runs after type detection and before `createResource`, allowing composable save-path transforms and hook-based resource discard before the `Resource` object is assembled.

Changed
------------
* **runtime: modernize internals (#1397)** — Remove the `mkdirp` and `css-url-parser` runtime dependencies, use built-in recursive `fs.promises.mkdir`, use `node:stream/promises.pipeline`, vendor CSS URL parsing as typed ESM, raise the TypeScript target to `es2022`, and use `Map` for worker-pool in-flight tasks.
* **worker: split task and log MessagePorts (#491)** — Worker task/result payloads and log payloads now use dedicated `MessageChannel` ports. The default `parentPort` is reserved for lightweight control messages, including graceful worker close so queued logs can drain before disposal finishes.

Fix
------------
* **resource: constrain disk writes to localRoot** — Sanitize literal and encoded dot segments in built-in HTTP(S) save paths, decode local `file://` URLs correctly, and reject save, HTML, streaming, and local-file copy paths whose resolved destination escapes `localRoot`.
* **worker-pool: reject in-flight tasks on worker exit** — Clear crashed worker load and reject tasks assigned to a failed worker instead of leaving callers waiting indefinitely.
* **process-css: rewrite parsed URL tokens only** — Replace CSS resource references at parser-reported positions so matching text in comments or string literals is preserved while duplicate resource processing is still avoided.
* **download-streaming-resource: reject destination write errors** — Treat write-side pipeline failures as terminal download failures instead of waiting for a request-side error event that may never arrive.

Breaking Changes
------------
* `ProcessingLifeCycle.generateSavePath` changes from a single optional generator to `GenerateSavePathFunc[]`. Consumers building the life cycle from scratch must add `generateSavePath: []`.
* `CreateResourceArgument.generateSavePathFn` and the exported `GenerateSavePathFn` type are removed. Use `lifeCycle.generateSavePath.push(...)` for new code, or `lifeCycle.adapter.wrapLegacyGenerateSavePath(fn)` to adapt an old full-generator function.
* `PipelineExecutor.createResource` can now return `void` when a `generateSavePath` hook discards the resource. Direct callers should check the result before using the returned resource.
* `StaticDownloadOptions.waitForInitBeforeIdle` is removed. It was deprecated since `0.8.2` and was no longer read by the runtime.
* Custom worker implementations must read `workerData.workerChannels.taskPort` for tasks/results and `workerData.workerChannels.logPort` for logs. `parentPort` no longer carries task completion or log messages.

New Exports
------------
* `lifeCycle.localUrlMounts()` and `lifeCycle.adapter.localUrlMounts()` — optional download lifecycle adapter for static local URL mounts
* `LocalUrlMount*` types, `LocalUrlMountNotFoundError`, and `LocalUrlMountFileSizeError`
* `GenerateSavePathContext`, `GenerateSavePathResult`, `GenerateSavePathFunc` — types for the save-path lifecycle stage
* `lifeCycle.adapter.wrapLegacyGenerateSavePath(fn)` — compatibility wrapper for old full save-path generators
* `downloader.getWorkerChannels()` and `WorkerChannels` — helper and type for custom worker scripts using the split worker transport

0.9.0
============

**BREAKING CHANGE** — see Breaking Changes and Migration sections below.

Feature
------------
* **logger: make logger implementation configurable (#204)** — Replace hardcoded log4js with a pluggable `Logger` interface. Consumers provide a factory via `DownloadOptions.createLogger`. Default implementation writes to `console`. Built-in log4js adapter at `lib/logger/log4js-adapter.js` for backward compatibility.
* **life-cycle: add statusChange listener hook (#102)** — New `statusChange` array on `ProcessingLifeCycle` allows consumers to observe resource progression through the pipeline. Default listener logs skipped/discarded resources and errors.
* **life-cycle: add existingResource callback for local file handling (#150)** — Optional `existingResource` callback on `ProcessingLifeCycle` to decide what to do when a local file already exists (skip, overwrite, if-modified-since, skipSave).
* **life-cycle: expose submit resource to init hook (#1131)** — `InitLifeCycleFunc` receives an optional `submit` callback to add URLs to the download queue during initialization.

Fix
------------
* **download: enable warnForNonHtml by default, improve warning (#993)** — `warnForNonHtml` is now enabled by default. Warning message includes `res.type` for clarity.

Breaking Changes
------------
* `DownloadOptions.configureLogger` replaced by `createLogger?: (options: StaticDownloadOptions) => Logger`. The default is `createDefaultLogger` (console-based).
* `log4js` moved from `dependencies` to `optionalDependencies`. Consumers who need file-based logging must `npm install log4js` and use the built-in adapter:
  ```typescript
  import {createLog4jsLogger} from 'website-scrap-engine/lib/logger/log4js-adapter.js';
  const options = {
    createLogger: (opts) => createLog4jsLogger(opts.localRoot, opts.logSubDir),
  };
  ```
* Public `logger` namespace exports are typed as `CategoryLogger` instead of log4js `Logger`. Method signatures are compatible (`.trace()`, `.debug()`, `.info()`, `.warn()`, `.error()`, `.isTraceEnabled()`), but consumers using log4js-specific properties will need to update.
* Worker log message protocol: `WorkerLog.logger` (category string) replaced by `WorkerLog.logType` (LogType string). Affects custom worker implementations only.
* `ProcessingLifeCycle` gains a required `statusChange: StatusChangeFunc[]` field. Consumers building the life cycle from scratch must add `statusChange: []`.
* `warnForNonHtml` is now enabled by default (was opt-in).

New Exports
------------
* `Logger` interface — the pluggable logger contract
* `LogType` type — discriminated union of log categories (`io.http.request`, `system.error`, etc.)
* `CategoryLogger` interface — the per-category proxy type (what `logger.error`, `logger.skip` etc. are)
* `createDefaultLogger()` — factory for the console-based default logger
* `logger.setLogger(instance)` — configure the logger instance at runtime
* `logger.getLogger()` — retrieve the current logger instance

Misc
------------
* docs: rewrite README with usage examples, architecture details, and adapter helpers
* build(deps): bump picomatch, @typescript-eslint/eslint-plugin, @typescript-eslint/parser, handlebars, ts-jest

0.8.8
============

Misc
------------
* npm: bump version

0.8.7
============

Fix
------------
* npm: fix postinstall failure when installed as a dependency
* npm: fix Node.js DEP0151 deprecation warning for ESM main field resolution

0.8.6
============

Fix
------------
* worker-pool: rewrite task dispatch with 2-pass water-fill algorithm for even load balancing
* worker-pool: reject pending tasks on dispose when maxLoad is set
* process-css: single-pass positional replacement to prevent corrupting already-replaced paths
* download-resource: fix inverted nonHtml detection for array content-type headers
* download-resource: pass missing `options` arg to requestForResource on retry
* download-resource: guard premature close retry with retryLimitExceeded check
* download-resource: wrap encodeURI(decodeURI()) in try-catch for malformed URLs
* download-resource: check Buffer bodies (not just strings) on incomplete HTML retry
* download-streaming-resource: apply computed backoff delay via setTimeout on retry
* options: fix inverted maxRetryAfter comparison
* save-html-to-disk: convert Date.parse milliseconds to seconds for fs.utimes
* save-resource-to-disk: convert Date.parse milliseconds to seconds for fs.utimes
* save-html-to-disk: escape single quotes in redirect HTML JS string literal
* read-or-copy-local-resource: create parent directory before copyFile for StreamingBinary
* worker: assign cloned error back so worker errors propagate to main thread
* worker-pool: only call takeLog for Log messages, not Complete messages
* adapters: widen parseHtml and getResourceBodyFromHtml type to accept Svg

Test
------------
* redirect-html: test encoding and single-quote escaping
* download-streaming-resource: test isBytesAccepted, isSameRangeStart
* options: test calculateFastDelay retry limit, maxRetryAfter, non-retryable methods

Misc
------------
* npm: exclude undici from bundle
* npm: update dependencies

0.8.5
============

Enhancement
------------
* [worker-pool: cast err to Error](https://github.com/website-local/website-scrap-engine/commit/d8fecbaa088d7f7fb5632c099c7a7753731825ec)

Misc
------------
* npm: update dependencies

0.8.4
============

Enhancement
------------
* Upgraded to typescript 5.9

Test
------------
* tests: support typescript 5.9

Misc
------------
* npm: update dependencies

0.8.3
============

Fix
------------
* options: fix got options memory leak (#1112)
* downloader: correctly set queue.concurrency (#1113)

0.8.2
============

Fix
------------
* downloader: use of options before init (#1110)

Misc
------------
* npm: update dependencies
* options: deprecate waitForInitBeforeIdle

0.8.1
============

Enhancement
------------
* sources: support iframe srcdoc (#1081)
* download-resource: add option to warn for non-html (Part of #993)

Test
------------
* tests: process-html (#1092)

0.8.0
============

BREAKING
------------
* [Requires node.js 18.17 or higher](https://github.com/website-local/website-scrap-engine/commit/c8974a6e42e121230e674b722bf06be186e9e41e)
* Support of es module (and not supports commonjs) ([#995](https://github.com/website-local/website-scrap-engine/pull/995)) ([#218](https://github.com/website-local/website-scrap-engine/issues/218))
* build(deps-dev): bump typescript from 5.0.4 to 5.6.2 ([#990](https://github.com/website-local/website-scrap-engine/pull/990))
* build(deps): bump cheerio from 1.0.0-rc.12 to 1.0.0 ([#989](https://github.com/website-local/website-scrap-engine/pull/989))
* npm: upgrade to lockfile v3 ([#437](https://github.com/website-local/website-scrap-engine/issues/437))
* [migrate to got 13](https://github.com/website-local/website-scrap-engine/commit/c0796cff3f6f8c879a0be1e7e5cbd8545cd2cc7b)
* [change importDefaultFromPath to async](https://github.com/website-local/website-scrap-engine/commit/27aa83db3ae8422c9ae0f798f0706144e2a8e82f)

Misc
------------
* npm: update dependencies

0.7.2
============

Note
------------
* This would be the last version before updating minimal supported node version

Misc
------------
* npm: update dependencies

0.7.1
============

Enhancement
------------
* sources: add video poster
* process-html: handle meta refresh redirect (#897)

Test
------------
* npm: upgrade jest to 28

Misc
------------
* npm: update dependencies
* npm: initial npm provenance support (#898)

0.7.0
============

BREAKING
------------
* build(deps): bump mkdirp from 2.1.6 to 3.0.0
* build(deps-dev): bump typescript from 4.9.5 to 5.0.4

0.6.0
============

BREAKING
------------
* resource: custom callback for rewriting savePath
* life-cycle: custom callback for rewriting savePath (<https://github.com/website-local/website-scrap-engine/issues/383>)

Fix
------------
* cheerio: replace deprecated api

Test
------------
* test: migrating to eslint v8 and typescript-eslint v5
* cheerio: fix a test
* resource: add a test
* ci: run tests on node.js 18.x (<https://github.com/website-local/website-scrap-engine/issues/610>)

Misc
------------
* package-lock-resolved: process registry.npmmirror.com
* logger: fix type conflict
* util: fix compatibility with typescript 4.8
* npm: drop @types/mkdirp
* update deps

0.5.0
============

BREAKING
------------
* typescript 4.4 support
  * WorkerMessage: `error` can be `unknown`
  * StreamingDownloadErrorHook: `e` can be `unknown`
* pipeline-executor-impl fix keepSearch param
* resource: redirectedSavePath not set after redirect

Test
------------
* test: adapt for jest 27 and ts-jest 27

0.4.0
============

BREAKING
------------
* worker-pool: load based worker pool (#11)
* cheerio: adapt for version 1.0.0-rc.10 (#271)
* test: adapt for URI.js v1.19.7 (#301)

Fix
------------
* downloader: correctly transfer resource body
* correctly convent ArrayBufferView to Buffer
* worker-pool: fix ready

Enhancement
------------
* npm: update
* life-cycle: add init and dispose life cycle
* resource: optionally redirected savePath
* resource: take a log on replacing long search string
* save-to-disk: optionally use remote date
* worker-pool: log worker errors
* worker-pool: custom initializer of worker

Test
------------
* worker-pool: basic unit test
* save-html-to-disk: initial unit tests with mocked fs
* save-to-disk: refactor tests

0.3.2
============

* resource: fix redirected path processing (#157)
* downloader: optional wait for this.init in method onIdle (#152)
* typescript: prefer type only import

0.3.1
============

* resource: use correct file scheme for windows (#145)

0.3.0
============

New Feature
------------
* life-cycle: extract and process source maps (#123)
* adapters: async processHtml
* life-cycle: add read-or-copy-local-resource
* resource: support file protocol (#126)

Misc
------------
* types: export type CheerioElement
* resource: optional skip replacePath processing in case of parser error (#107)
* resource: fix new type of Buffer.from (#116)
* build(deps): bump cheerio from 1.0.0-rc.3 to 1.0.0-rc.5
* io: mkdirRetry returns no string
* life-cycle: add download-streaming-resource to default
* skip-links: skip unix scheme
* skip-links: allow file protocol
* download: skip non-http url
* (BREAKING) resource: refactor createResource (#139)

0.2.0
============
* life-cycle: streaming download and save binary resource to disk
* build(deps-dev): bump @types/cheerio from 0.22.21 to 0.22.22

0.1.7
============
* resource: parse and process standalone svg images
* save-html-to-disk: keep location hash in redirect placeholder
* detect-resource-type: export lowerCaseExtension
* downloader: log downloadLink instead of rawUrl
* typescript: update to v4.0

0.1.6
============
* save-resource-to-disk: compare redirectedUrl with url
* process-html: submit resources from inline css
* downloader: correctly use adjustTimer on start
* downloader: deduplicate on redirectedUrl
  downloader: do not wait for complete on add

0.1.5
============
* downloader: do not wait for complete on add
* process-html: fix detecting type
* npm: update p-queue to 6.6.0
* npm: move copy script to build

0.1.4
============
* save-html-to-disk: fix redirect check
* logger: add logger for skipExternal

0.1.3
============
* save-html-to-disk: fix redirect placeholder path

0.1.2
============
* adapters: make processRedirectedUrl named function
* options: move initialUrl and logSubDir to StaticDownloadOptions
* options: retry on error codes
* download-resource: manually retry on got internal errors
* io: refactor mkdirRetry
* process-html: skip invalid srcset

0.1.1
============
* io: remove mkdirRetrySync and update writeFile
* util: arrayToMap could freeze the object returned if required
* detect-resource-type: fix url with search and hash
* options: allow merging got options from StaticDownloadOptions
* options: add comments
* life-cycle: convent default life cycle fn to named function

0.1.0
============
Initial release.
