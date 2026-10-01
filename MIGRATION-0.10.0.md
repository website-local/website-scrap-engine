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
The built-in worker is already updated.

`WorkerPool.ready` now waits for every worker's `Ready` control message, after
configuration and pipeline initialization succeed. Send `Failed` with an `error`
string when initialization fails. Tasks submitted before readiness are queued.
Startup failures reject readiness, terminate the pool, and settle queued tasks.
The default startup deadline is 30 seconds; configure `startupTimeout` in the
sixth `WorkerPool` constructor argument, or use `workerPool: {startupTimeout}`
in multi-thread downloader options. A custom worker must send `Ready` explicitly.

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
  if (type === WorkerControlMessageType.Close) {
    taskPort.close();
    logPort.close();
    parentPort.postMessage({type: WorkerControlMessageType.Closed});
  }
});
parentPort.postMessage({type: WorkerControlMessageType.Ready});
```

Keep the existing log-message payload, but send it on `logPort`. Close both ports
before acknowledging shutdown so queued logs can drain. Custom worker factories
must forward the supplied worker options, including `workerData` and
`transferList`.

For code that directly uses worker-pool internals:

- `workingTasks` is a `Map`: use `.get(id)`, `.set(id, task)`, `.delete(id)`, and
  `.size` instead of record indexing and `Object.keys`.
- `onMessage` is replaced by `onControlMessage`, `complete`, and `takeLog` for
  the corresponding channels.
- `WorkerInfo` requires `taskPort` and `logPort`; `WorkerInfoImpl` takes
  `(worker, taskPort, logPort)`.

## Other changes

- Remove `waitForInitBeforeIdle` from options. It was deprecated and unused.
- Call `io.mkdirRetry(dir)` without a retry argument. It now makes one recursive
  filesystem call; implement an explicit retry policy if your application needs it.
- Successful empty responses, including HTTP 200, 204, and HEAD, no longer
  trigger additional requests. Configure `req.retry` for transport failures;
  an application-level empty-content retry policy must be implemented separately.
- `p-queue` is upgraded to version 9. Code accessing the exposed queue directly
  should check its version 9 APIs and Node requirement.

## Request options and normalized resources

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
