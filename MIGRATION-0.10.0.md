# Upgrading from 0.9.1 to 0.10.0

Version 0.10.0 requires Node.js 22.13.0 or newer and changes the save-path and
custom-worker APIs. The Node 24 publishing environment is separate from this
runtime minimum.

Pipeline `linkRedirect`, `detectResourceType`, and `processBeforeDownload` now
return synchronous values when their hooks are synchronous, as permitted by
`PipelineExecutor`'s `AsyncResult` contract. Use `await` rather than calling
`.then()` directly on a concrete executor's result. Async hooks still run in
order and retain cancellation and short-circuit behavior.

Direct buffered/streamed writes on supported platforms use `O_NOFOLLOW` to
reject destination symlinks at open time. Windows and generic publication
writers retain the explicit destination check. Streaming output now uses a
256 KiB write buffer instead of Node's default 64 KiB; this trades up to an
additional 192 KiB per active output stream for fewer small writes.

## Dependency installation

`log4js` is now an optional peer instead of an automatically installed optional
dependency. If you use the file-logging adapter, run `npm install log4js` alongside
the library. Default console logging requires no additional package. This removes
the unused logging dependency tree from ordinary installations.

The package no longer has a postinstall script that copies declarations into a
nested Undici directory. The repository's existing Undici size override now uses
a TypeScript path mapping to its own declaration shim, which is included with the
published source/configuration. Clean development installs work with lifecycle
scripts disabled and with either nested or hoisted dependency placement.

npm does not apply a dependency package's root overrides to its consumers.
Ordinary installations therefore retain Cheerio's real Undici dependency and
real declarations; the repository's size optimization does not claim to remove
Undici from consumer installations.

## Save-path hooks

`ProcessingLifeCycle.generateSavePath` is now an array of hooks. Each receives
the current path and a context object. Hooks may be asynchronous; return a path
to continue, or `undefined` to discard the resource before creation.

```ts
import {lifeCycle} from 'website-scrap-engine';

const lc = lifeCycle.defaultLifeCycle();
lc.generateSavePath.push((savePath, ctx) => {
  if (ctx.uri.hostname() === 'cdn.example.com') {
    return savePath.replace('cdn.example.com', 'assets');
  }
  return savePath;
});
```

When constructing a lifecycle manually, add `generateSavePath: []`. To adapt a
previous full-generator callback, use:

```ts
lc.generateSavePath.push(
  lifeCycle.adapter.wrapLegacyGenerateSavePath(oldGenerator)
);
```

The adapter ignores the incoming path and calls the old generator. Prefer a
transform hook when combining several path customizations.

The `resource.GenerateSavePathFn` type and
`CreateResourceArgument.generateSavePathFn` property are removed. Use
`lifeCycle.types.GenerateSavePathFunc` for hooks. For direct `resource.createResource`
calls, calculate a path yourself and pass `savePath`.

`PipelineExecutor.createResource` can now return `void`; await its result and
check it before accessing the resource. This applies to custom pipeline code
that previously assumed creation always succeeded.

## Custom workers

Tasks and results use `workerData.workerChannels.taskPort`; logs use
`workerData.workerChannels.logPort`. `parentPort` carries control messages.
Worker envelopes no longer carry or check a protocol version: workers and the
parent must use the same installed runtime. Task IDs, task ownership, message
shapes and duplicate completions are still checked. The old version constant and
optional type fields remain deprecated compatibility exports.

The multi-thread downloader creates its pool on the first task that needs worker
processing and retains that pool until disposal. Streaming-only crawls create no
workers. Set `waitForWorkers: true` to create the pool during initialization and
wait for readiness; alternatively await `downloader.pool.ready` to warm it explicitly.
With the default, worker startup failures reject worker tasks instead of `init`.

`WorkerPool.ready` now waits for every worker's `Ready` control message, after
configuration and pipeline initialization succeed. Send `Failed` with an `error`
string when initialization fails. Tasks submitted before readiness are queued.
Startup failures reject readiness, terminate the pool, and settle queued tasks.
The default startup deadline is 30 seconds; configure `startupTimeout` in the
sixth `WorkerPool` constructor argument, or use `workerPool: {startupTimeout}`
in multi-thread downloader options. A custom worker must send `Ready` explicitly.

Use `workerPool: {taskTimeout: 30000}` to limit the time from dispatch to a worker
until its completion message. There is no task deadline by default. A timeout or
message-decoding failure terminates the affected worker and rejects all tasks
assigned to it. Undispatched tasks continue on surviving workers, or reject if
none remain. Assigned tasks are never replayed automatically: a failed worker
may already have performed side effects. `shutdownTimeout` configures the
worker cancellation/close grace period (1000ms by default). All deadlines are positive integer
milliseconds, at most 2147483647.

A minimal custom worker looks like:

```js
import {parentPort} from 'node:worker_threads';
import {downloader} from 'website-scrap-engine';

const {taskPort, logPort} = downloader.getWorkerChannels();
const {WorkerMessageType, WorkerControlMessageType} = downloader.types;

taskPort.on('message', ({taskId, body}) => {
  taskPort.postMessage({taskId, type: WorkerMessageType.Complete, body});
});

parentPort.on('message', ({type}) => {
  if (type === WorkerControlMessageType.Close || type === WorkerControlMessageType.Cancel) {
    taskPort.close();
    logPort.close();
    parentPort.postMessage({type: WorkerControlMessageType.Closed});
  }
});
parentPort.postMessage({type: WorkerControlMessageType.Ready});
```

Send log envelopes on `logPort`; no `version` is required. Close both ports
before acknowledging shutdown so queued logs can drain. Custom worker factories
must forward the supplied worker options, including `workerData` and
`transferList`.

When cancelled, the built-in worker aborts `pipeline.signal`, waits for active
hooks to settle, then closes its channels. Hooks can use `finally` to clean up
after observing the signal. The parent waits for this acknowledgement up to
`shutdownTimeout`, then terminates the worker. Custom workers handling asynchronous
tasks should implement the same `Cancel` behavior; the minimal echo example above
has no asynchronous work to await. Queued/active task promises reject on disposal,
and the disposal promise waits for worker shutdown. Task deadlines and protocol
failures terminate workers immediately rather than granting this cleanup grace.

Downloader task bodies and returned children use `resource.WireResource`.
Use `resource.prepareResourceForClone(res)` before sending and
`resource.decodeResourceFromClone(body)` after receiving. Snapshots contain the
canonical URL/path strings and cloneable metadata, without `uri`, `refUri`,
`replaceUri`, `host`, or `meta.doc`. Decoding validates the resource fields and
reconstructs URI instances and binary views. A malformed returned child batch is
rejected before any child from that batch is admitted. Encoding preserves the
body buffer for transfer and copies nested metadata; do not reuse a transferred
buffer in the sending thread.

For code that directly uses worker-pool internals:

- `workingTasks` is a `Map`: use `.get(id)`, `.set(id, task)`, `.delete(id)`, and
  `.size` instead of record indexing and `Object.keys`.
- `onMessage` is replaced by `onControlMessage`, `complete`, and `takeLog` for
  the corresponding channels.
- `WorkerInfo` requires `taskPort` and `logPort`; `WorkerInfoImpl` takes
  `(worker, taskPort, logPort)`.

## Other changes

Failed download, processing, and save attempts no longer increment
`downloadedCount`. Once a failed task settles, its URL reservation is released so
the application can explicitly resubmit it; there is no automatic task replay.
Successful tasks remain deduplicated. Create a fresh resource for a network retry,
especially after worker buffer transfer. A retry is a new admission for
`maxResources`; previously admitted children retain their own reservations.

Optional scheduling limits are positive integers:

- `maxResources` caps total resource admissions for a crawl; duplicates and rejected
  submissions do not consume admissions.
- `maxQueuedResources` caps waiting resources, excluding active tasks. This also
  applies while the downloader is paused, including initial URL admission.
- `maxDiscoveredResources` caps child submissions per parent task, including
  duplicates and queue-rejected submissions. Exceeding it throws
  `ERR_DISCOVERY_LIMIT` from `submit`, with numeric `limit` and `actual` fields.
  Earlier children remain eligible if the parent subsequently fails. Built-in
  workers check this before collecting/cloning further children, and the parent
  checks custom-worker batch length before decoding it. Omitted means unlimited.
- `maxConcurrency` caps initial concurrency, assignments through
  `downloader.concurrency`, and automatic adjustment. An explicit `minConcurrency`
  above this ceiling is rejected.
- `maxResourceBytes` limits downloaded resource bytes, including decompressed
  HTTP data, local reads/copies, and bodies supplied at admission or hook boundaries.
  String bodies are measured using their resource encoding. Exact-limit bodies
  are accepted; oversized resources fail with `ERR_RESOURCE_SIZE_LIMIT`.
- `maxBufferedBytes` caps aggregate body reservations within a downloader. It
  includes supplied queued bodies, buffered HTTP/local reads, active task-body
  high-water marks, generated output passed to `io.writeFile`, and child bodies
  awaiting worker-result delivery/admission. Omitted means unlimited. A resource
  admission that cannot reserve its supplied body returns `false`; growth during
  processing fails that attempt with `ERR_BUFFER_BUDGET` and numeric `limit` and
  `actual` fields. It never waits for queue capacity held by the parent task.

Total and queue limits are unlimited when omitted. Admission rejects immediately
with `false` and an error status whose `res.meta.error.code` is `ERR_CRAWL_LIMIT`
and whose `limit` identifies the exceeded option. Queue-limit rejections can be
resubmitted after capacity becomes available. Use downloader admission APIs rather
than adding tasks directly to its exposed queue to retain these guarantees.

Retaining a processing hook's `submit` callback beyond its parent task is no
longer supported: submissions after completion or cancellation throw. Await
asynchronous discovery inside the hook. Child work is independent of the parent's
eventual save/processing outcome; no rollback of earlier children is attempted.
Worker crashes can still lose a batch not yet delivered to the parent. The
discovery count does not bound metadata size or allocations made by custom hooks.

The built-in opt-in concurrency adjustment now compares completion rates using
elapsed time. A stalled saturated queue halves its concurrency; a rate drop over
20% reduces it by a quarter. Stable/improving rates add at most one slot per
observation. It respects `minConcurrency` and `maxConcurrency`; without an
explicit maximum, the configured initial concurrency is the ceiling (or an
explicit higher minimum). An empty or unsaturated queue does not trigger growth,
and start/resume resets sampling so paused time does not look like a slowdown.
This is a conservative heuristic, not a latency/throughput optimizer. Use fixed
concurrency or a custom `adjustConcurrencyFunc` for workload-specific control.
Custom-policy metadata is preserved. `adjustConcurrencyPeriod`, when supplied,
must be an integer from 1 to 2,147,483,647 ms; omit it to leave the built-in policy
disabled. A supplied custom callback still uses a 60-second default period.

The per-resource byte limit is optional. It is not a process-memory limit: parser
objects, temporary copies, and generated HTML serialization can consume additional
memory. Worker errors now preserve standard error name/message/stack and primitive
`code`, `limit`, and `actual` fields in a plain transport record.

`downloader.bufferedBytes` and `peakBufferedBytes` expose current and peak reserved
bytes (zero when accounting is disabled). Each active task retains its largest
observed body reservation until it settles; replacing a body with a smaller one
does not immediately free capacity. Child credits transfer into accepted child
tasks without double charging; duplicate/rejected children release their unused
credits when the parent settles. Failures, retries, cancellation and worker exit
release the appropriate reservations. Even a worker that never sends its first
accounting request must exit before the parent releases its transferred body.

Workers obtain byte credits through the parent publication channel. Supplied
child bodies may be retained while their credit requests are pending, but are
returned to the parent only after acknowledgement. Failed child credit requests
fail the parent attempt while already acknowledged children remain eligible;
worker-side byte-budget failures may therefore surface after a synchronous
`submit` call returns. Custom workers that allocate/transform bodies must implement
equivalent accounting to obtain the built-in worker guarantees.

This is a logical body-reservation budget, not an exact live-memory ceiling.
Streaming resources do not reserve their entire file size. Stream buffers, DOMs,
metadata, codec/transport copies, simultaneous body representations, and temporary
allocations inside custom hooks are outside it. A custom hook's new body is checked
at the next pipeline boundary, after the hook has allocated it. Use it together
with `maxResourceBytes`, discovery/queue limits and bounded concurrency, and allow
additional memory headroom. Separate downloaders have independent budgets.

Downloader output uses **direct writes by default**, including HTTP streams,
local copies and worker saves. A failed or cancelled write may leave partial
output and may overwrite a previously cached file. Set `atomicWrites: true` to
stage each file and publish by rename; failed writes then preserve the old file.
Atomicity is per file, not a multi-file transaction or a power-loss guarantee.

Save policies run before direct output is opened. HTTP streams check the
response-aware save policy before opening the file, and 304 responses leave the
cached file and timestamps unchanged. Range retries reuse the output (or staging
file in atomic mode) after the previous stream closes.

Built-in worker writes still reserve destinations and confirm successful writes
through the parent-owned `publicationPort`. Allocation replies include a `direct`
flag so clients can evaluate save policies before writing. On timeout, crash or
forced cancellation, atomic staging is cleaned up; partial direct output remains.
A completed publication remains counted if the worker subsequently crashes.
Custom factories must forward the transferred publication port. Custom filesystem
writes outside these helpers require their own coordination.

Within one downloader, different canonical admission URLs cannot publish to the
same destination. The first output allocation reserves the resolved path; a
conflicting attempt fails with `ERR_OUTPUT_CONFLICT` instead of silently replacing
another resource. An unpublished allocation releases ownership after cleanup.
Confirmed output retains ownership for the crawl, including when a later hook
fails; the same URL can retry its own output. This also applies when a redirect
or custom save-path hook maps distinct resources onto one file. It does not
disambiguate names or rewrite links automatically. Separate crawler instances
and direct filesystem writes require their own coordination. Root symlink aliases
share reservations, and Windows reservation keys are case-insensitive.

Custom `PipelineExecutor` implementations must provide
`shouldSaveResource(res): Promise<boolean>`, which rechecks the existing-resource
save policy. Built-in local copy handlers use it before publication; the default
executor shares that check with buffered saves.

Output roots and parent directories are resolved/prepared once per crawl by
default. The configured root may itself be a symlink; its first resolved target
remains the trusted root for that crawl. Do not delete, replace or retarget the
output directory tree during a crawl. Set `strictOutputChecks: true` to resolve
roots and check parent directories on every write. Atomic publication always
rechecks the parent immediately before rename. Direct writes reject an existing
destination-file symlink; atomic mode replaces that symlink without following it.
Standalone publication helpers outside a downloader context retain atomic behavior.
Portable path checks do not defend against hostile concurrent directory replacement.

- Remove `waitForInitBeforeIdle` from options. It was deprecated and unused.
- Call `io.mkdirRetry(dir)` without a retry argument. It now makes one recursive
  filesystem call; implement an explicit retry policy if your application needs it.
- Successful empty responses, including HTTP 200, 204, and HEAD, no longer
  trigger additional requests. Configure `req.retry` for transport failures;
  an application-level empty-content retry policy must be implemented separately.
- `p-queue` is upgraded to version 9. Code accessing the exposed queue directly
  should check its version 9 APIs and Node requirement.

## Request options and normalized resources

Automatic resource normalization happens when decoding worker-boundary data,
not between lifecycle hooks or at queue admission. Hooks and custom factories
must return a valid `Resource` and keep its URL/URI fields consistent. If a hook
changes canonical strings or returns a structured clone, explicitly call
`normalizeResource` before handing it to another hook or submitting it. Body-size
and configured buffered-memory limits are still checked independently.

Got is upgraded from 13 to 16. HTTP/2 agents, DNS caching, and cross-origin
credential handling follow Got 16's contracts. Option merging uses public plain
snapshots instead of `_internals`; a request URL remains a separate argument.
Truncated responses retain strict content-length checks and use the configured
retry limit. Explicit `retry.errorCodes` continues to override library defaults.

`Resource.uri`, `refUri`, and `replaceUri` are required URI.js instances, and
`host` is a required string (possibly empty for a local URL). Use `createResource`
or `normalizeResource` rather than constructing a partially initialized Resource.
Queue submissions now require `Resource`, not `RawResource`. Worker snapshots
use strings and are normalized on receipt.

Worker resource snapshots preserve structured-clone-compatible nested metadata.
Parsed DOMs stay local; metadata containing functions now fails explicitly rather
than being silently omitted. Callers should use serializable metadata.

## Explicit crawl lifetime

Construction and `init` no longer start downloads. `await downloader.start()`
starts or resumes the paused queue and exposes initialization errors. `stop()`
pauses admission to execution; it does not abort an active request. A pending
`start()` followed by `stop()` stays paused.

`dispose()` cancels queued and active work and awaits cleanup. It is idempotent:
repeated calls return the same promise. Use `dispose({drain: true})` to finish
already accepted work instead. Both modes reject new submissions, including
children discovered after closure starts. `onIdle()` alone does not start a paused
queue. The `state` property exposes the crawl's current lifecycle state.

Custom hooks can observe `pipeline.signal` to stop cooperative work. Arbitrary
user promises cannot be forcibly interrupted; disposal waits for them. Built-in
requests receive the crawl signal, and the pipeline checks cancellation before
continuing into later stages. Failed initialization is safe to dispose.

Logging and cancellation are scoped to each crawl's asynchronous context, so
creating a second downloader no longer replaces the first downloader's logger.

## Resource outcomes and download counts

`downloader.outcomes` is a read-only typed map of immutable snapshots, keyed using
the same fragment/query normalization as admission. It records the latest accepted
attempt and its terminal state without retaining bodies or DOMs. Failed explicit
retries replace the previous snapshot and increment `attempt`.

`downloadedCount` now includes successful HTTP streams and local streaming copies,
which previously returned void without being counted. It excludes failed and
cancelled attempts. A body successfully acquired but skipped by the save policy
still counts, matching buffered behavior; pre-download skips and HTTP 304 do not.
The outcome's `downloaded` flag describes acquisition independently of final
success, and `publishedFiles` can be nonzero on a later failure. With `atomicWrites: true`, publication is atomic per file. Direct-write failures
can leave partial files even when `publishedFiles` is zero.

Built-in workers return an optional validated `progress` object with a nonnegative
safe-integer `publishedFiles` and boolean `skipped`. Custom workers may supply it to
report publications/save-policy skips. Omitted progress yields `processed` for
successful buffered work. Malformed progress fails the attempt.

The streaming `downloadError` hook now observes an error and then propagates it;
`afterDownload` is not called for a failed transfer. Returning from the error hook
no longer silently turns the failure into completion. Implement recovery in a
download hook that returns a replacement resource, or explicitly resubmit after
failure. Supplied empty-string bodies are also treated as acquired content instead
of triggering another request; remove `body` when a fresh download is intended.
