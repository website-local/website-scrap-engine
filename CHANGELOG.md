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

