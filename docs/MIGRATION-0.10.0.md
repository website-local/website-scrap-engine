# Migrating to 0.10

0.10 is unreleased. It keeps the 0.9.1 crawl and worker architecture, replaces
URIjs with native URL handling, supports application-selected GroveDOM, and
retains the applicable performance improvements. Default regressions are
forbidden by the [project rules](0.10-design.md#development-rules-and-validation-tools).

## From 0.9.1

Use Node.js 22.13.0 or newer. Replace URIjs imports in resource and lifecycle
hooks with the engine's exported `URI` and `NativeUri` types. The compatibility
wrapper uses WHATWG URL resolution; consult the [URL migration guide](native-url-migration.md)
for IDNA, escaping and supported methods.

The full save-path callback is retained:

```ts
import {lifeCycle, resource} from 'website-scrap-engine';
const lifecycle = lifeCycle.defaultLifeCycle();
lifecycle.generateSavePath = (uri, html, keepSearch, localSrcRoot) =>
  resource.generateSavePath(uri, html, keepSearch, localSrcRoot);
```

Direct resource callers can still supply `generateSavePathFn`. Lifecycle arrays,
the three-argument `PipelineExecutorImpl` constructor, discovery callbacks and
custom worker messages on `parentPort` retain their 0.9.1 forms.

`Resource` contains normalized `uri`, `refUri`, `replaceUri` and `host` fields.
Create resources through the engine helpers; hooks returning replacements must
maintain those invariants. `prepareResourceForClone` omits URI instances, DOMs
and status promises. Nested metadata is copied by `postMessage` at dispatch;
the preparation helper does not take an earlier deep snapshot. Metadata must
be structured-cloneable.

Await `downloader.dispose()` in a `finally` block. It stops admissions, drops
queued work, settles worker tasks and awaits active work and disposal hooks.
The request's `AbortSignal` controls cancellation of active network transfers.
`onIdle()` waits for initialization. Workers start lazily; streaming-only
downloads do not create processing workers. The public `pool` getter starts a
pool when explicitly accessed. Pools retain their task-ID record and shared
task/log port protocol.

Successful empty responses and supplied empty-string bodies are content and do
not cause extra transport retries. Got retry limits and cancellation remain
authoritative. Interrupted direct streams retain validated range recovery;
errors can leave partial files. Configure a request signal or an explicit
application policy when cancellation or publication semantics are needed.

Download lifecycle hooks may return `true` for successful terminal acquisition,
such as a completed streaming write or local copy. This skips buffered processing;
`undefined` still means no acquisition. Direct callers of `pipeline.download()`
must distinguish `true` from a resource. Completed streams count as downloaded;
304 responses, skipped downloads and failed processing or cleanup do not.
Failures release their admission before error callbacks, allowing immediate
resubmission. Redirect aliases are admitted only after successful cleanup.

`existingResource` save policies also apply to streaming HTTP and local copies.
The decision sees response/source metadata before output creation. A skipped
HTTP save drains the response and preserves the existing file. Streaming hooks
adopt returned replacement resources and propagate acquisition and cleanup errors.

### Request configuration

`defaultDownloadOptions()` copies caller settings and supplies engine defaults.
Ordinary Got settings are validated when a request is issued; call
`checkDownloadOptions()` to validate them before starting. Configured Got init
hooks and native transport still normalize at construction. Reusing an options
object without overrides preserves its identity and does not rerun init hooks;
an actual request override is normalized once.
Omitted `req.headers` stays undefined, as in 0.9.1; supply a headers object before
editing individual header entries.

Downloader and worker initialization refresh built-in handler selection after
application configuration. Ordinary uncached downloads avoid per-request cache
hook inspection. Configured caches and Got request hooks select guarded handlers.
Lifecycle callbacks are not scanned to predict future request-option changes.
If a lifecycle callback or external code enables caching or adds request hooks
after initialization, call `options.selectDownloadHandlers(config)` after that
change. The public request/lifecycle helpers also remain available for guarded
direct calls. Worker configurations remain owned and initialized by their
respective application modules; reselect in each module that changes its settings.

`io.mkdirRetry(dir)` now performs one recursive mkdir and propagates its error.
Remove the old retry-count argument. Install `log4js` explicitly to use the
optional file-logging adapter. The declaration-copy postinstall is removed.

### Native HTTP transport

Set `httpTransport: 'native'` to opt into the Node HTTP(S) transport. It supports
GET/HEAD, redirects, gzip/deflate/Brotli, bounded retries, `Retry-After`, request
deadlines, cancellation and validated range recovery. Native defaults use two
retries and a request timeout; configure `req.retry` explicitly when needed.
Cookies, caches, custom agents/hooks/retry calculators, phase-specific timeouts
and other unsupported Got settings fall back to Got before sending a request.
Native errors provide HTTP metadata rather than Got request instances.

Initialization selects the built-in lifecycle handlers. The default Got
lifecycle does no per-resource native selection, import or metadata recording;
native-only factories initialize on first native use. Custom lifecycle hooks
are preserved. Direct `requestForResource` and `streamingDownloadToFile` callers
can pass the download options to select native transport explicitly.

## Parser selection and ownership

Cheerio is the default. Provide a synchronous `loadHtml` in the application
options module to use GroveDOM. Import and initialize the parser separately in
each worker; parser functions cannot be sent in static overrides. See the
[GroveDOM guide](grovedom.md).

For downloader submissions, the engine takes ownership of `meta.doc` when the resource enters
`downloadAndProcessResource`. From then on, it disposes managed documents after
save, discard or failure and after pending status observers finish. Use
`.eq(index)` for selection indexing in GroveDOM fast-mode hooks. Retaining a
disposed document beyond its resource's processing is unsupported.

Before execution begins, an application that attached a document to a resource
still owns it. Admission does not transfer that ownership: duplicate/depth
rejection, submission during shutdown, and queued entries removed by
`queue.clear()` or `downloader.dispose()` leave unprocessed documents with the
caller. The caller must dispose them if execution never starts, and must not
dispose a document already transferred to active processing. Direct calls to
lifecycle/parser helpers retain those helpers' disposal behavior, including
cleanup on discard or replacement before admission.

Submit HTML through `resource.body` without a precreated `meta.doc`. The default
HTML processing hook invokes `loadHtml` after execution begins; custom DOM work
belongs in the active resource's `processAfterDownload` hooks. Apply the same
rule to `submit(child)` inside a lifecycle hook. The [GroveDOM guide](grovedom.md)
shows a body-only submission. Applications requiring documents before admission
must opt into their own ownership and rejection/cancellation cleanup. This keeps
ownership registries and per-admission document checks off the default path.

## From earlier unpublished 0.10 builds

Publication coordinators, path reservations, resource outcome histories,
admission/body budgets, staged writes and worker protocol/version channels have
been removed. Their overhead does not belong in the default crawl. Remove their
options and API calls. Workers and the main thread use direct filesystem writes;
applications decide how to avoid conflicting output paths and preserve old files.

Use the 0.9.1 save-path function instead of an array of save-path hooks. Hooks use
the `logger` namespace or their own logger; a per-pipeline logger is no longer
required. Custom executors do not implement publication or reservation methods.

Precreated document ownership also changes from those unpublished builds: the
downloader no longer promises cleanup merely because a caller submitted or
queued a resource. Caller ownership lasts until active processing begins, as
described above. This retains 0.9.1's behavior for rejected and cleared queued
resources; 0.9.1 had no managed-parser disposal API. Deterministic cleanup of
engine-loaded documents and their pending status observers during processing
remains in place.

Validation results for earlier 0.10 builds describe those historical builds only.
The [0.10 design guide](0.10-design.md) records retained decisions and the
current performance qualification limits.

### Opt-in resource byte limits

Applications can import the resource-size helpers from
`website-scrap-engine/lib/resource-limits.js` in their options module. For
example, to discard buffered bodies larger than 8 MiB before parsing or saving:

```ts
import {lifeCycle} from 'website-scrap-engine';
import {checkResourceBody} from 'website-scrap-engine/lib/resource-limits.js';

const lifecycle = lifeCycle.defaultLifeCycle();
lifecycle.processAfterDownload.unshift(res =>
  checkResourceBody(res, 8 * 1024 * 1024) ? res : undefined);
```

This hook runs after buffering. For limits during acquisition, custom download
handlers can use `readResourceFile(path, encoding, limit, signal, res)` for
local reads or pipe through `limitResourceStream(limit, resumeOffset, res)`
before writing. A local read returns `undefined` on overflow. The stream
raises `ERR_RESOURCE_SIZE_LIMIT` and may already have forwarded earlier chunks.
Pass the size of the existing prefix when resuming. Built-in terminal streams
and local copies bypass buffered postprocessing. Limits apply only where the
application installs them. They measure input bytes, not DOM or process memory.

TypeScript consumers can again refer to `logger.Logger`, `logger.CategoryLogger`
and `logger.LogType` through the package's logger namespace.

## Body ownership after saving

The built-in savers consume the body after every output write and pending status
observer finishes. They clear `resource.body` and release a complete detachable
backing store, including bodies supplied as Buffers, typed views or ArrayBuffers.
This is the default behavior; no additional save hook is needed. Failed writes
or failed cleanup leave the body available. Partial views, shared memory,
pooled buffers, protected stores and WebAssembly memory are not detached; the
resource still drops its reference after a successful save.

Submit children during `processAfterDownload`. A submitted byte body gets an
independent copy before the parent can be saved. Ordinary URL-only discoveries
and strings need no byte copy. Children must not retain their parent or its
parsed document in custom metadata. This applies to both downloader modes,
including children waiting for a worker reply.

Copy bytes during processing if application code needs to retain them after
saving. Every view of an eligible saved backing store becomes detached. Custom
savers retain their own body-ownership policy. For opaque local files that need
no buffered processing, `ResourceType.StreamingBinary` continues to use the
filesystem copy path.
