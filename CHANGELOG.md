0.10.0 (unreleased)
============

**BREAKING CHANGE** — Requires Node.js 22.13.0 or newer. Read
[MIGRATION-0.10.0.md](MIGRATION-0.10.0.md) before upgrading from 0.9.1.

Breaking changes
------------

* Drop Node 18 and 20; upgrade Got 13 to 16 and p-queue 8 to 9.
* Replace URIjs with the exported `URI` native URL compatibility wrapper. Hooks must migrate URI imports and types; absolute parsing follows WHATWG URL rules. See the [native URL migration guide](docs/native-url-migration.md) for supported APIs and compatibility limits.
* Downloaders wait for an explicit, awaitable `start()`. `dispose()` cancels and awaits cleanup by default; use its explicit drain mode to finish accepted work.
* Require normalized `Resource.uri`, `refUri`, and `replaceUri`. Worker tasks/results use validated `WireResource` snapshots, preserve cloneable nested metadata, and exclude URI/DOM instances.
* Custom workers use task/log channels and control messages on `parentPort`, announce readiness, and handle shutdown. Worker factories must forward all supplied transferred ports, including the publication/accounting channel.
* Replace the full save-path callback with composable `GenerateSavePathFunc[]` hooks. Manually constructed lifecycles need `generateSavePath: []`; the legacy-generator adapter supports migration. Remove `GenerateSavePathFn` and `CreateResourceArgument.generateSavePathFn`; pipeline resource creation can return `void` when a hook discards a resource.
* Count successful streamed/local-copy acquisitions in `downloadedCount`, while excluding failed/cancelled attempts. Streaming error hooks propagate failure and do not run success hooks afterward.
* Successful empty HTTP responses finish without extra retries; supplied empty-string bodies are treated as content. Implement an explicit empty-response retry policy when required.
* Distinct canonical URLs targeting the same output within a crawl fail with `ERR_OUTPUT_CONFLICT`. Confirmed output retains ownership across later failure and same-URL retry.
* Make log4js an optional peer: file-logging adapter users must install it explicitly; default consumers omit its dependency tree.
* Change `WorkerPool.workingTasks` to a Map and split task/log handlers. Remove `waitForInitBeforeIdle` and the retry argument from `io.mkdirRetry`. See the migration guide for custom pool interfaces.
* Reject discovery submissions after their parent task completes. The opt-in concurrency controller now backs off on stalls and grows gradually within bounds; adjustment periods must fit Node's positive-integer timer range.

Performance
------------

* Add opt-in native HTTP(S) for GET/HEAD with bounded retries, request deadlines, redirects, decompression and resource limits. Native defaults to two retries, supports retry backoff and Retry-After, and restarts interrupted streams without retaining partial bytes. Custom retry callbacks and unsupported request options fall back to Got before I/O; Got remains the default.
* Cache unchanged normalized request snapshots without retaining merge history, and avoid promise turns for prepared output directories.
* Reuse URI parsing during resource creation and deduplication; reuse a private parsed reference URL across links without sharing mutable URI instances with hooks.
* Avoid extra promise turns for synchronous link/type/before-download hooks and duplicate request-option normalization. Keep unchanged implicit Got defaults out of request snapshots.
* Reduce temporary allocations in combined link creation, SVG processing and synchronous hook execution; remove unused CSS URL regex captures while preserving replacement offsets.
* Reuse the path-segment array during save-path escaping, and avoid reparsing unchanged inline styles while preserving existing CSS-hook and rewriting behavior.
* Reuse the existing relative-path helper when writing redirects with a supplied target save path, retaining the URI compatibility wrapper fallback for unusual paths.
* Reuse completed synchronous status notifications and reduce pending-notification bookkeeping while preserving listener order, call receivers and disposal waiting.
* Reduce query-ordering temporaries and encode long-query filename hashes directly as URL-safe base64, preserving existing output.
* Share private staging directories across overlapping publications, keeping individual file ownership and cleanup before idle.
* Check existing output parents with one canonical path resolution, retaining symlink rejection and publication-time checks. Remove successful empty staging directories without recursive cleanup probes.
* Reuse normalized publication destinations and reservation paths instead of resolving and reconstructing the same paths repeatedly.
* Keep worker logging imports out of the direct single-thread entry and defer the HTML parser until markup processing. Pools remain one-shot and live until downloader disposal.
* Keep synchronous link/type/before-download pipelines synchronous; coalesce duplicate bodyless discoveries before serialization and worker transfer, retaining discovery counting and byte-budget behavior. Validate actual transport payloads; unused duplicate metadata is not cloned.
* Avoid URI hostname classification for already-absolute URLs, reduce redundant URI copies, overlap local metadata/body reads, and use callback file I/O behind promise interfaces.
* Use kernel no-follow opens for supported direct writes instead of a separate destination probe, forwarding this guarantee through worker publication requests. Generic writers and Windows retain explicit destination checks. Increase the streaming write buffer to 256 KiB.
* Add a combined synthetic/MDN regression runner and an isolated HTTP transport probe. Remaining regressions are reported per workload, without an aggregate performance pass.

Crawl control and reliability
------------

* Expose readonly per-attempt resource outcomes for acquisition, confirmed publication, skipping, failure and cancellation. Failed URL reservations release after settlement for explicit retries; successful redirect aliases survive concurrent target failures.
* Add optional `maxResources`, `maxQueuedResources`, `maxConcurrency`, `maxDiscoveredResources`, `maxResourceBytes` and `maxBufferedBytes`. Report exceeded limits rather than blocking recursive discovery. Current/peak byte statistics describe logical body reservations, not total process memory.
* Keep worker byte credits in the parent, transfer child credits without double charging, and await failed-worker exit before releasing transferred bodies—even before the first worker RPC. Previously acknowledged children remain eligible after a later parent failure.
* Bound worker initialization and optional task deadlines; validate message ownership, payloads and duplicate completions. Retire failed workers while healthy workers continue undispatched tasks without replaying failed work.
* Scope logging and cancellation to each crawl. Worker disposal supports cooperative cancellation followed by forced termination after the configured grace period.
* Default downloader output to direct writes; failures/cancellation may leave partial files. Set atomicWrites for staged publication and preservation of cached files on failure. Save-policy skips and 304 responses preserve cached output in both modes.
* Let the parent own worker output reservations and publication. Clean atomic staging after worker failure; direct partial output remains. Preserve confirmed publication counts after later failure.

Fixes and performance
------------

* Bypass Got's response cache for requests containing Cache-Control: max-stale, including hook changes, redirects and retries in buffered and streaming downloads. This mitigates GHSA-ch52-4w7c-c8xp; http-cache-semantics has no patched release yet, so the dependency advisory remains open.

* Cache output-directory preparation per crawl by default; strictOutputChecks restores per-write preparation. Initialize worker pools once on demand and retain them until disposal; waitForWorkers restores eager readiness. Omit worker protocol-version fields and checks.

* Calculate relative replacement paths directly for ordinary local filenames, with the URI compatibility wrapper fallback for encoded and unusual paths. Reuse matching parsed response URLs and skip unused default path generation before the built-in legacy full-path adapter.
* Use Got's public option snapshots instead of private history-bearing internals. Preserve hook/agent configuration without mutation and wrap Got 16 binary responses as Buffer views without copying bytes.
* Retain content-length validation, bounded transport retries and range-resume behavior; await previous streams before retrying and remove legacy manual retry timers.
* Normalize resources only when decoding worker-boundary data. Hooks, factories and queue callers maintain Resource invariants; body-size limits remain independent.
* Avoid redundant output-directory creation while retaining containment checks. Reuse a single owned chunk in bounded local reads, but compact slices to avoid retaining oversized backing buffers.
* Avoid accounting RPC for empty child bodies and unchanged worker body sizes.
* Share body-size calculations between adjacent resource-limit checks and buffer accounting, including queue admission, preserving validation order and recalculating after hooks change bodies or encodings.
* Track processed CSS URLs with a Set instead of retaining unused resource values, and remove the worker fallback for runtimes without structuredClone.
* Fix CSS replacement offsets when a URL matches the surrounding url()/@import syntax or a quoted value contains whitespace.
* Coalesce pending worker dispatch callbacks while retaining asynchronous dispatch and worker capacity limits; skip task-timer cleanup when deadlines are disabled.
* Complete successful worker publications in the parent for both output modes, avoiding a separate release request for atomic writes while preserving ownership and failed-worker cleanup.
* Skip empty cleanup for completed worker tasks and look up publication connections by worker. Failed tasks still await worker exit before releasing allocations or transferred-body credits.
* Reuse the synchronous-hook promise check, consolidate retry defaults and logging, and resolve the default worker path directly from the module URL without changing custom worker-factory arguments.
* Keep eligible Got retries at a minimum delay of 1 ms so rounded jitter and Retry-After: 0 cannot accidentally stop retries; exhausted limits and ineligible requests still stop.

Tooling and validation
------------

* Retain TypeScript 6.0.3, Node 22 typings and Jest after compiler/runner audits; update compatible lint dependencies. `npm test` now checks the complete source/test TypeScript suite before Jest.
* Remove the declaration-copy postinstall. Keep the development Undici shim through TypeScript configuration; consumers retain Cheerio's declared dependency graph.
* Add deterministic worker/transport/outcome/budget regressions, repeated-crawl stress checks, strict packed-consumer fixtures and reproducible alternating crawl/queue benchmarks. CI covers Node 22.13, latest 22, 24 and 26.

0.9.1
============

Compatible update from 0.9.0. The declared Node.js minimum remains 18.17.0.

Fix
------------
* **download: respect transport retry settings** — Honor Got retry limits, methods, and hooks. Preserve the existing retry policy for successful empty responses.
* **download: preserve cached resources** — Handle HTTP 304 without retrying or overwriting cached files in buffered and streaming downloads.
* **resource: preserve binary data** — Respect explicit `null` encoding and use binary defaults for binary resources.
* **resource: keep writes inside localRoot** — Sanitize dot segments in generated HTTP(S) paths, decode local file URLs correctly, and reject output paths outside the configured root.
* **worker: preserve options and handle failures** — Forward static overrides, avoid mutating caller configuration, resolve the default ESM worker path, and reject tasks assigned to failed workers while continuing on healthy workers.
* **process-css: preserve unrelated text** — Rewrite parsed URL tokens without replacing matching text in comments or string literals.
* **process-html: preserve meta-refresh paths** — Keep literal dollar sequences such as `$$` when rewriting refresh URLs.
* **download-streaming-resource: handle local files and write errors** — Allow local-file fallback and reject destination write failures promptly.
* **types: include public URI declarations** — Include `@types/urijs` for consumers of the resource and lifecycle APIs.

Feature
------------
* **life-cycle: add local URL mounts** — Optional `lifeCycle.localUrlMounts()` and `lifeCycle.adapter.localUrlMounts()` helpers map HTTP(S) URL prefixes to local directories, with priority, longest-prefix matching, index resolution, case handling, and configurable fallback.

Performance
------------
* **process-css: deduplicate URL processing** — Use a `Set` instead of repeated scans while preserving URL order and rewrite positions.
* **existing-resource: check metadata asynchronously** — Reuse a file stat within each download/save phase and recheck before saving to observe files changed during download.

Compatibility and maintenance
------------
* Retain the 0.9.0 save-path callback and resource creation contracts, custom-worker messages on `parentPort`, public worker-pool APIs, `mkdirRetry(dir, retry)`, and the deprecated `waitForInitBeforeIdle` option.
* Retain `p-queue` 8 and the existing Undici exclusion. Node 18 consumers must configure that exclusion in their application; Cheerio's pre-existing Node 20.18.1 engine declaration still applies to strict-engine installs. See README for setup details.
* Modernize internal filesystem, stream, and CSS parsing helpers and update development dependencies. Development tooling requires Node 20.19+, 22.13+, or 24+; CI separately checks the Node 18 runtime.

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
