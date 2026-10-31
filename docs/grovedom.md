# Downstream GroveDOM loader

Cheerio remains the default. Applications can supply an initialized,
Cheerio-compatible loader through `loadHtml`. This guide uses the published
**GroveDOM 0.1.2 pooled-Wasm package**, installed in the consuming application:

```sh
npm install grovedom@0.1.2
```

Import and initialize GroveDOM in the application's options module:

```js
import {init, load} from 'grovedom';
import {lifeCycle, options} from 'website-scrap-engine';

init({heap: 'pool', poolSize: 4, poolMaxBytes: 8 * 1024 * 1024});

export default options.defaultDownloadOptions({
  ...lifeCycle.defaultLifeCycle(),
  localRoot: './offline',
  loadHtml: load,
});
```

Each worker imports the options module locally. Module resolution, initialization
timing and pool configuration belong to the application. If several options
modules use the same parser, put its initialization and loader export in one
shared module. Initialize the parser before the first load; an asynchronous
initializer can be awaited during options-module evaluation, but `loadHtml`
itself must remain synchronous.

The `htmlParser` and `grovedom` options are removed. They no longer select a
parser or configure a pool. Supply `loadHtml` instead; the engine has no
GroveDOM module registry. Import failures and loader errors propagate to the
caller.

## Downstream HTML loaders

An application can statically import a synchronous, Cheerio-compatible loader
and provide it in its options module:

```js
import {load} from 'cheerio';
import {lifeCycle, options} from 'website-scrap-engine';

export default options.defaultDownloadOptions({
  ...lifeCycle.defaultLifeCycle(),
  localRoot: './offline',
  loadHtml: load,
});
```

`loadHtml(content, parseOptions, isDocument)` receives the same three arguments
as Cheerio's `load`. It is called synchronously without a bound `this`. Omit or
clear it in the options module to use the default Cheerio loader. The engine
reads the function for each parse, so independent downloaders can supply
different loaders.
`prepareHtmlParser()` does no work for a supplied function; the application owns
any required parser initialization.

Define or import the function in the options module, which each worker imports
locally. Functions are not supported in the cloneable constructor overrides.
The returned document belongs to `res.meta.doc` and follows the same disposal
rules below, including an optional synchronous `dispose()` method. The loader
owns the behavior of any nested `document.load()` calls. Binary resources do not
call it. Static imports run when the application imports its options module;
without a supplied loader, the engine retains its existing lazy parser loading.

## Downstream pool controls

Pass `poolSize` and `poolMaxBytes` directly to GroveDOM's `init()` as shown
above. These control retained idle Wasm instances and bytes per process/worker;
they do not cap active document memory, total RSS or memory across all workers.
Worker counts multiply the possible idle budget. GroveDOM 0.1.2 does not expose
live pool resizing or explicit draining.

Configure the pool in the application, consistently for each imported module.
Engine constructor overrides no longer merge or validate these settings.
The example initializes when the options module is imported, including for
binary-only work. Applications that need lazy initialization can implement it
inside their supplied synchronous loader; binary resources never call that
loader. Document creation and disposal remain tied to each resource.

## Hooks and standalone transformations

Use the engine's `loadHtml` export and pass parser options as its **fourth
argument**. Its first three arguments keep the Cheerio `load(content, options,
isDocument)` shape. Omitting parser options selects Cheerio; there is no ambient
parser selection or document scope.

A resource owns its parsed document in `res.meta.doc`. Built-in HTML, SVG and
sitemap processing creates documents only when needed. A hook that needs the
document earlier can attach it explicitly:

```js
import {lifeCycle, loadHtml, resource, util} from 'website-scrap-engine';

const lc = lifeCycle.defaultLifeCycle();
lc.processAfterDownload.unshift((res, _submit, options, pipeline) => {
  if (res.type !== resource.ResourceType.Html) return res;
  const $ = res.meta.doc ??= loadHtml(
    util.toString(res.body, res.encoding), options.cheerioParse, undefined, options
  );
  $('p').attr('class', 'saved');
  pipeline.logger.debug('custom.html', 'Updated', res.url);
  return res;
});
```

Built-in save and discard paths dispose and clear `res.meta.doc`, including
failure and cancellation. `disposeHtmlResource(res)` provides this cleanup for
direct pipeline callers; await it in `finally`. It waits for pending resource
status work, including notifications started by earlier listeners, before
releasing the document. Status observers are read-only and may run asynchronous
work concurrently. Create or replace resource documents in processing hooks;
return asynchronous observer work so cleanup can wait for it.

Temporary documents have their own lifetime. Dispose each in `finally` after
serialization. This also applies to documents returned by `$.load()`; disposing
one document does not dispose another:

```js
import {loadHtml} from 'website-scrap-engine';
import options from './my-options.js';

const $ = loadHtml('<p>example</p>', undefined, undefined, options);
let html;
try {
  $('p').attr('class', 'saved');
  html = $.html();
} finally {
  $.dispose?.(); // GroveDOM releases its Wasm document; Cheerio needs no disposal.
}
```

Custom hooks replacing `res.meta.doc` must dispose the old document before
assignment. The `processHtml` and `processHtmlAsync` adapters handle replacements
returned by their callbacks. Await asynchronous work that uses the document;
documents, selections and nodes are invalid after disposal.

Documents never cross the worker boundary. Serialize changes made by main-thread
download hooks into `res.body` before worker processing. For generated child
resources, serialize and dispose the temporary document before calling
`submit(child, res, pipeline)`. Resources retain no child array or pipeline.

## Compatibility

Existing Cheerio-facing hook types remain for compatibility. The opt-in backend
implements the engine's exercised Cheerio-shaped subset; it does not make every
Cheerio method, parser option, plugin or raw domhandler operation available.
Cross-document node adoption is unsupported. Some positional selectors and
HTML/XML options differ. Pass only options supported by the selected backend.

The TypeScript loader contract retains Cheerio's types. GroveDOM's declared
API is smaller; assert the exercised compatibility boundary in the application:

```ts
import {load} from 'grovedom';
import type {HtmlParserOptions} from 'website-scrap-engine';

// Initialize GroveDOM as above before supplying this function.
const loadHtml = load as unknown as NonNullable<HtmlParserOptions['loadHtml']>;
```

This assertion does not add unsupported Cheerio operations to GroveDOM.

Use published 0.1.2 for this integration. The current downstream-loader checks
and the older adapter qualifications below identify their respective revisions.
Earlier scoped-ownership results remain historical evidence.

Installed-consumer checks for those earlier revisions on
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

## Downstream-loader qualification (2026-10-31)

The application-owned loader implementation passes build, lint, strict source/test
types and **54 suites / 1,159 tests** on existing Node 24.18.0. Six tests for
the removed engine pool/alias configuration were retired. Custom-loader
ownership, cancellation, retries, asynchronous status work and worker cleanup
remain covered. All 163 source, test and consumer-script files match the
validated isolated copy, excluding the unrelated local shared-context draft.

The packed engine passes strict consumer declarations and **15 runtime check
groups**, including both downloaders, the optional logging peer, custom loaders
and published GroveDOM 0.1.2. Each custom/GroveDOM ownership group covers sixteen
mode/failure cases. The existing consumer's dummy Undici package requires a
local type-path mapping to its existing `undici-types` declarations, retaining
`skipLibCheck: false`; this is not a fresh locked installation. No dependency
or third-party file was changed.

Both isolated MDN consumers build; the final one passes **390 tests**. A markup
helper now explicitly accepts `StaticDownloadOptions & HtmlParserOptions`,
with identical emitted MDN JavaScript. The actual MDN checkout remains on
engine 0.9.1 and receives no source or dependency changes from this cleanup.

Eight preflight and 1,257 further successful recorded pipelines preserve
original bytes, paths, status events and requests. A harness scratch-directory
creation failure is retained separately. The [paired measurements and deeper
profiles](performance.md#downstream-parser-setup-2026-10-31) retain an unresolved
warmed GroveDOM canvas slowdown, so passing correctness checks does not provide
unconditional performance clearance. Node 22, native Windows, sustained memory
and complete-archive/browser validation were not newly qualified.

## Review follow-up qualification (2026-10-27)

Commit `3a84caa`, following the ownership refactor in `02aa109`, passed builds,
lint, strict source/test types, and **53 suites / 1,138 tests** on Node 22.22.2
and 24.18.0. The final packed engine passed strict consumer declarations and
all 15 runtime check groups on
both runtimes, including both downloaders, the logging peer, all 16 GroveDOM
ownership/pool cases, and module aliases with CommonJS-only exports.

Both builds emit identical files. All 276 installed engine files match the
validated build/source; all 37 reused GroveDOM files and its published 0.1.2
tarball match the preserved package hashes. No dependency installation was
needed. New regressions cover streaming-hook replacement ownership and local
path boundaries. Custom executors must expose the existing
`replaceResource` operation; see the [migration guide](../MIGRATION-0.10.0.md#lifecycle-dependencies-and-document-ownership).
The final commit also joins concurrent asynchronous status observers before
resource cleanup and shutdown; observers remain read-only.

The [object layout review](object-layout-review.md) records the measured worker
heap reduction and the absence of a reliable crawl speedup. The older 193-case
and frozen MDN replays remain evidence for their dated engine revisions.
Full-archive/browser validation and an admissible consumer performance
measurement remain adoption requirements. Cheerio remains the default.

## Explicit ownership qualification (2026-10-25)

Fresh builds and all **52 suites / 1,114 tests** pass on Node 22.22.2 and
24.18.0. A newly packed engine also passes all 15 installed-consumer check
groups on each runtime with published GroveDOM 0.1.2 and the optional logging
peer. These include strict declarations, both downloaders, publication conflicts,
retries, discovery limits, HTTP transport, all 16 ownership/pool cases, and
module aliases including a reserved package name and CommonJS-only exports.

Regression coverage includes lazy parsing, asynchronous status listeners,
replacement/error/cancellation cleanup, discarded duplicate children, and
documents released after worker child serialization or serialization failure.
The same already-queued resource can be resubmitted without disposing its active
document. Ordinary input-limit breaches are logged discards.

This pass reused the existing published package and dependencies. The older
193-case and frozen MDN replay results below were not rerun and remain evidence
for their recorded engine revisions. Full-archive/browser adoption validation
and an admissible consumer performance measurement remain open. Cheerio remains
the default; the focused link-array experiment found no reliable speedup.

## Published 0.1.2 qualification

The 2026-10-24 checks used a fresh npm installation of the published tarball and
a package built from the then-current development engine working tree. The engine
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

**Continue consumer migration and qualification in `mdn-local`.** As checked on
2026-10-28, its original checkout still uses engine 0.9.1 in both the lockfile
and installation. Its download and release workflows still use
Node 20. Engine adapter qualification is complete for the revision above;
adopting that engine and validating MDN's own transforms are the next work.

The [engine API patch](mdn-native-url-migration.patch) and
[document ownership patch](mdn-grovedom-migration.patch) preserve the migration
tested in isolated MDN copies on 2026-10-24. That evidence left the original
MDN checkout and engine 0.9.1 installation unchanged. The ownership patch uses
the removed `withHtmlParser` and parser-selection APIs and requires adaptation
before use with the current engine; it is retained as historical evidence.

For current MDN hooks, pass parser options to each `loadHtml` call and store the
page document in `res.meta.doc`. Generated playground runners must be serialized
and disposed before `submit(child, res, pipeline)`. Standalone sample merging
must dispose every temporary document in `finally`, after extracting detached
values or serialized HTML. Keep Cheerio as the default and pass parser options
explicitly when opting into GroveDOM. Apply the other API changes in the
[0.10 migration guide](../MIGRATION-0.10.0.md), including `pipeline.logger`, and
run consumers on Node >=22.13.0.

Use this order in the consumer repository:

1. Migrate the engine APIs, package runtime requirement and CI to Node >=22.13.0,
   then build and test a Cheerio baseline against the selected engine commit.
2. Add explicit GroveDOM ownership to hooks and standalone transforms. Compare
   both parsers on the same engine/options and frozen original responses:
   saved bytes, paths, submissions, status events and complete document cleanup,
   including both downloader modes.
3. Measure the complete required DOM workload with fixed inputs and controls,
   including bindings, callbacks, serialization and disposal. The adoption
   target remains at least **3× current Cheerio**, while also beating its
   fastest compatible configuration. Profile that consumer before choosing
   further optimizations; input-byte and idle-pool limits are not heap limits.
4. Validate full locale archives and offline browser behavior from the actual
   adopted MDN revision, including live examples, BCD tables, redirects, search
   targets and local assets. Record sustained memory separately.

Keep Cheerio as default while these gates remain open. Earlier replay results
qualify their recorded revisions. GroveDOM library development remains paused;
reopen library or engine work when the consumer identifies a reproducible defect
or a measured optimization opportunity. Closed library campaigns stay closed.

## Validate an installed consumer

After building and installing the engine package and GroveDOM 0.1.2 in a separate
consumer, run this command from the engine repository:

```sh
node scripts/check-consumer.mjs /path/to/consumer --grovedom
```

This checks the installed declarations, application-supplied loaders in both
downloaders, and lifecycle cleanup with the installed GroveDOM package. It covers
success, discarded resources, download/processing/save failures, retries,
cancellation, binary-only work and application-owned initialization. Add `with-peer`
when the consumer also has the optional `log4js` peer installed. Add
`--smoke-only` for the shorter declarations/parser check. No GroveDOM
development dependency is required by the engine's default test suite.
