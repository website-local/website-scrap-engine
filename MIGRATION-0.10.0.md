# Upgrading from 0.9.1 to 0.10.0

Version 0.10.0 requires Node.js 22.13.0 or newer and changes the save-path and
custom-worker APIs. The Node 24 publishing environment is separate from this
runtime minimum.

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
Every task, result, log, and control envelope now requires `version: 1`. Use
`downloader.types.WORKER_PROTOCOL_VERSION` when constructing messages. A version
mismatch retires the worker and rejects its assigned tasks. The built-in worker
is already updated.

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
const {WorkerMessageType, WorkerControlMessageType, WORKER_PROTOCOL_VERSION} = downloader.types;

taskPort.on('message', ({version, taskId, body}) => {
  if (version !== WORKER_PROTOCOL_VERSION) throw new Error('Worker protocol mismatch');
  taskPort.postMessage({version: WORKER_PROTOCOL_VERSION, taskId, type: WorkerMessageType.Complete, body});
});

parentPort.on('message', ({version, type}) => {
  if (version !== WORKER_PROTOCOL_VERSION) throw new Error('Worker protocol mismatch');
  if (type === WorkerControlMessageType.Close || type === WorkerControlMessageType.Cancel) {
    taskPort.close();
    logPort.close();
    parentPort.postMessage({version: WORKER_PROTOCOL_VERSION, type: WorkerControlMessageType.Closed});
  }
});
parentPort.postMessage({version: WORKER_PROTOCOL_VERSION, type: WorkerControlMessageType.Ready});
```

Add `version` to existing log envelopes and send them on `logPort`. Close both ports
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

Optional scheduling limits are positive integers:

- `maxResources` caps total resource admissions for a crawl; duplicates and rejected
  submissions do not consume admissions.
- `maxQueuedResources` caps waiting resources, excluding active tasks. This also
  applies while the downloader is paused, including initial URL admission.
- `maxConcurrency` caps initial concurrency, assignments through
  `downloader.concurrency`, and automatic adjustment. An explicit `minConcurrency`
  above this ceiling is rejected.

Total and queue limits are unlimited when omitted. Admission rejects immediately
with `false` and an error status whose `res.meta.error.code` is `ERR_CRAWL_LIMIT`
and whose `limit` identifies the exceeded option. Queue-limit rejections can be
resubmitted after capacity becomes available. Use downloader admission APIs rather
than adding tasks directly to its exposed queue to retain these guarantees.

Buffered saves now write a temporary file beside the destination and publish it
by rename. Failures and cancellation observed before publication leave the prior
destination intact; normal cleanup removes the temporary directory. Publication
is atomic per file, not across a redirected resource's multiple output files.
This does not promise durability after power loss. Local streaming-file copies
and streaming URL mounts also use staged publication and recheck the save-stage
existing-resource policy before publishing. HTTP streams now use the same staged
publication and policy check. Range retries reuse the staging file after the
previous stream closes; 304 responses and skipped saves discard staging without
changing the cached file or its timestamps. Stream retries follow Got's configured
retry policy; legacy manual retry timers have been removed.

Custom `PipelineExecutor` implementations must provide
`shouldSaveResource(res): Promise<boolean>`, which rechecks the existing-resource
save policy. Built-in local copy handlers use it before publication; the default
executor shares that check with buffered saves.

Built-in buffered saves reject symlinked directories below `localRoot`. The
configured root itself may be a symlink; its resolved target is treated as the
trusted root. A destination-file symlink is replaced, leaving its former target
untouched. Direct `io.writeFile` callers can pass `localRoot` as the sixth argument
to enable these checks. The output directory tree must remain under application
control: these portable path checks do not defend against a hostile process
concurrently replacing directories between filesystem operations.

- Remove `waitForInitBeforeIdle` from options. It was deprecated and unused.
- Call `io.mkdirRetry(dir)` without a retry argument. It now makes one recursive
  filesystem call; implement an explicit retry policy if your application needs it.
- Successful empty responses, including HTTP 200, 204, and HEAD, no longer
  trigger additional requests. Configure `req.retry` for transport failures;
  an application-level empty-content retry policy must be implemented separately.
- `p-queue` is upgraded to version 9. Code accessing the exposed queue directly
  should check its version 9 APIs and Node requirement.

## Request options and normalized resources

Before-download, download, after-download, and save hook chains normalize every
returned resource before invoking the next hook. Canonical `url`, `refUrl`, and
`replacePath` strings determine the corresponding URI instances; changing those
strings in a hook updates the URI fields at the next hook boundary. Returning a
structured clone is supported. Invalid canonical fields reject the stage before
subsequent hooks run.

Got is upgraded from 13 to 16. HTTP/2 agents, DNS caching, and cross-origin
credential handling follow Got 16's contracts. Option merging uses public plain
snapshots instead of `_internals`; a request URL remains a separate argument.
Truncated responses retain strict content-length checks and use the configured
retry limit. Explicit `retry.errorCodes` continues to override library defaults.

`Resource.uri`, `refUri`, and `replaceUri` are required URI.js instances, and
`host` is a required string (possibly empty for a local URL). Use `createResource`
or `normalizeResource` rather than constructing a partially initialized Resource.
Raw submissions still use strings. Normalization repairs structured-cloned URI
objects and refreshes fields when canonical strings change.

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
