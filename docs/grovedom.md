# Experimental GroveDOM backend

Cheerio remains the default. The optional GroveDOM adapter targets the published
**0.1.2 pooled-Wasm package**. Install it in the consuming application:

```sh
npm install grovedom@0.1.2
```

Select the backend in the downloader options:

```js
import {lifeCycle, options} from 'website-scrap-engine';

export default options.defaultDownloadOptions({
  ...lifeCycle.defaultLifeCycle(),
  localRoot: './offline',
  htmlParser: 'grovedom',
  grovedom: {
    // Optional: resolve from this application for isolated dependency layouts.
    // module: import.meta.resolve('grovedom'),
    poolSize: 4,
    poolMaxBytes: 8 * 1024 * 1024,
  },
});
```

Without `module`, the engine resolves `grovedom` from its own package location.
For dependency layouts that isolate undeclared packages, pass
`module: import.meta.resolve('grovedom')` from the application's options module.
Absolute paths and file URLs to packaged Wasm entries are also supported.
Specifiers resolving to the same loaded entry share initialization, pool settings
and nested document ownership. This includes file URLs with query strings or
fragments and packages exposing only a CommonJS entry. Conflicting pool settings
are rejected across aliases.
The module must expose GroveDOM's Wasm `init()` and `load()` APIs. Native addon
initialization is not supported by this adapter. There is no silent fallback
when the selected package is missing or a parser option is unsupported.

## Downstream pool controls

`grovedom.poolSize` defaults to **8 idle Wasm instances** and
`grovedom.poolMaxBytes` to **16 MiB of retained idle Wasm memory**, per process
or worker. Both accept nonnegative safe integers. Setting either to zero
disables retention. These limits do not cap active document memory, total RSS,
or memory across all workers. Worker counts multiply the possible idle budget.

The options are cloneable and can be supplied through downloader overrides.
Partial `grovedom` overrides merge with the options module, preserving its
module path and other pool limit. Configuration is fixed per module in each
process/worker; conflicting pool settings are rejected. Changing initialized
settings requires a new process or fresh workers. The 0.1.2 public API does not
expose live resizing or explicit pool draining.

Initialization is lazy and happens once per module in each process/worker.
Do not initialize the same module separately from a hook. Binary-only work does
not load or initialize the parser.

## Hooks and standalone transformations

Use the engine's `loadHtml` export for documents created by hooks, including
generated examples. It selects the current resource's backend and tracks each
document, as does the document's `$.load()` method. Direct imports from Cheerio
or GroveDOM bypass this ownership contract.

```js
import {loadHtml, withHtmlParser} from 'website-scrap-engine';

const html = await withHtmlParser({htmlParser: 'grovedom'}, () => {
  const $ = loadHtml('<p>example</p>');
  $('p').attr('class', 'saved');
  return $.html();
});
```

The built-in single-thread and worker downloaders keep the scope alive through
transformation, nested processing, serialization, save hooks and associated
status hooks. They dispose all owned documents on success, discard, failure or
cancellation. Nested scopes for the same backend reuse their parent's ownership.
Resources are cleared of owned documents on exit so retries parse fresh input.
Resource completion also waits for pending error and admission-status listeners,
including further notifications started by those listeners. Notifications raised
outside resource processing get their own scope with the configured parser.
Multi-thread parent download hooks have a separate scope from worker processing;
documents never cross the worker boundary. Serialize any intended body changes
before handing a resource to a worker.

Standalone pipeline callers must wrap processing **and saving/serialization**
in `withHtmlParser`. Return strings or other detached results. Documents,
selections and nodes must not be used after scope completion; asynchronous hook
work must be awaited. Standalone sample-merging utilities need their own scope.
Lifecycle init/dispose hooks outside resource processing can use explicit scopes.

## Compatibility

Existing Cheerio-facing hook types remain for compatibility. The opt-in backend
implements the engine's exercised Cheerio-shaped subset; it does not make every
Cheerio method, parser option, plugin or raw domhandler operation available.
Cross-document node adoption is unsupported. Some positional selectors and
HTML/XML options differ. Pass only options supported by the selected backend.

Use published 0.1.2 for this integration. Fresh installed-consumer checks on
Node 22.22.2 and 24.18.0 passed strict declarations, both downloader modes,
the optional logging peer, and all 16 ownership/pool scenarios per runtime.
The published tarball matched npm's SHA-512 integrity and SHA-1 checksum, and
all 37 installed package files matched the tarball.

Historical replay evidence: version 0.1.0 provides the required APIs, but its
offline engine/MDN replay matched only 183/193 scenarios, including a missed SVG
link rewrite. Published **0.1.1 matched all 193 scenarios** against Cheerio 1.2.0:
final serialized output, resource paths, submissions and logs. All 303 loaded
documents were disposed. A further **32 saved-file/link checks** matched and
resolved to the expected file bytes. These offline checks do not establish
arbitrary hook compatibility or a whole-crawl performance improvement.

## Published 0.1.2 qualification

The 2026-10-24 checks used a fresh npm installation of the published tarball and
a package built from the current development engine working tree. The engine
build and its **1,075 tests** passed with the existing development tools; those
tool versions differ from the lockfile. The separate consumer used real
Cheerio 1.2.0 and Undici 7.30.1, without the engine's development Undici stub.

| Check | Result |
| --- | --- |
| Installed declarations, downloader smokes, logging peer and ownership/pool checks | Passed on Node 22.22.2 and 24.18.0 |
| Retained engine/MDN corpus with published 0.1.2 | 193/193 exact matches; 303/303 documents disposed |
| Fresh original-response replay | 8/8 exact matches; 39 saved files; 23/23 documents disposed on Node 22 and 24 |
| Bounded MDN queue replay, both downloader modes | 32 identical files and 120 identical hook/status events per mode; 38/38 documents disposed |
| Saved-file/link probes | 32/32 identical, including resolved target bytes |
| Migrated MDN build and tests | Passed; 366 tests in 31 suites |
| Standalone sample merging with real 0.1.2 | 9 identical files; 3/3 documents disposed |

The fresh recording contains eight original MDN pages plus the six BCD responses
and two images required by their transformation callbacks. All 16 responses were
recorded before transformation and frozen for both parsers. The queue replay
admits these resources, generated runners and the two local injection assets.
Other linked pages and assets are outside that bounded replay.

The retained 193-case corpus includes saved, already transformed pages, authored
regressions and earlier original responses. Its fresh 0.1.2 run is separate from
the historical 0.1.1 result above and from the fresh original-response recording.
Both tested htmlparser2 configurations changed all eight fresh cases and
163–166 retained cases, so they did not qualify as exact-output replacements.
A fixed workload screen included complete DOM callbacks, serialization and
disposal on both panels. All 18 timing blocks exceeded the predeclared host
activity limits, so the retained timings support no qualified speedup claim.
These checks do not establish full-archive, browser, long-run memory or
whole-crawl performance qualification. Cheerio remains the default.

The completed 2026-10-25 engine review passed **54 suites / 1,093 tests** and the
installed-consumer checks on Node 22.22.2 and 24.18.0. Regression coverage includes
asynchronous error/admission listeners, notifications outside resource processing,
cancelled and replacement documents, module aliases (including URL suffixes and
CommonJS export conditions), and concurrent parser preparation and synchronous
loads. Secondary parser setup errors no longer escape synchronous error reporting.
A failing notification during shutdown still allows other notifications and
downloader cleanup to finish before the cleanup error is reported.
Replays with the fixed engine and published
0.1.2 again matched all 193 retained cases and eight frozen original-page cases,
including 39 saved files; all 326 GroveDOM documents were disposed per runtime.

## MDN ownership migration

The inspected MDN checkout uses engine 0.9.1. The migration was built and tested
in an isolated copy against this branch's development engine 0.10.0, leaving the
original checkout and its installed dependencies intact.

Apply the [engine API migration](mdn-native-url-migration.patch), then the
[document ownership migration](mdn-grovedom-migration.patch), with a built
development engine package. Engine 0.9.1 lacks the ownership exports.
Run the migrated consumer on Node >=22.13.0.

The playground hook uses `loadHtml` and serializes each generated runner before
queue submission. The queued resource contains its processed body and no
document handle, so it can outlive the parent scope and cross worker boundaries.
Sample merging owns documents per file and waits for all pending scopes before
reporting a batch failure.

The existing `mergeSamples(...paths)` entry point keeps Cheerio as its default.
For an explicit parser, pass the same parser options used by the downloader:

```js
import {mergeSamplesWithHtmlParser} from './lib/mdn/mdn-merge-samples.js';

await mergeSamplesWithHtmlParser({
  htmlParser: 'grovedom',
  grovedom: {module: import.meta.resolve('grovedom')},
}, './offline-en', './offline-zh');
```

## Validate an installed consumer

After building and installing the engine package and GroveDOM 0.1.2 in a separate
consumer, run this command from the engine repository:

```sh
node scripts/check-consumer.mjs /path/to/consumer --smoke-only --grovedom
```

This checks the installed declarations, default package resolution in both
downloaders, and lifecycle cleanup with the installed GroveDOM package. It covers
success, discarded resources, download/processing/save failures, retries,
cancellation, binary-only work and downstream pool overrides. Add `with-peer`
when the consumer also has the optional `log4js` peer installed. No GroveDOM
development dependency is required by the engine's default test suite.
