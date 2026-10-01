# 0.10.0 implementation and audit evidence

This is an unreleased implementation in progress. The release requires all
remaining gates below; passing an intermediate test run is not release approval.

## Completed foundation

- Runtime and CI minimum: Node 22.13.0; Node 24/26 coverage; publisher stays Node 24.
- Got 16 uses public `Options.toJSON()` snapshots, with `url` removed because Got
  requires it as a separate argument. Normalization does not reuse Options objects.
- Truncated responses retain content-length validation and join the bounded Got
  retry policy; explicit user error-code lists remain authoritative.
- Configuration containers and defaults are copied, preserving opaque objects and
  function identities. Runtime resource URI fields are required; normalization
  repairs stale or structured-cloned instances.
- Nested cloneable metadata survives transport; unsupported metadata fails rather
  than disappearing. DOMs are excluded.
- Build and 280 tests passed on Node 24.18.0. Runtime checks also target the exact
  minimum before the foundation commit.

`node --expose-gc scripts/benchmark-options.mjs` exercises 12,000 merges and checks
that hooks do not multiply, snapshots stay plain, and retained heap plateaus.
An optional argument accepts Got 13's `dist/source/core/options.js` to reproduce
issue #1112. The original reuse pattern retained 1,000 `_init` entries after
1,000 merges; the public-snapshot path had no growing retained heap after warm-up.
Raw local measurements are under `artifacts/wse-010-implementation/`.

## Completed crawl lifetime

- Queues begin paused; `start()` is awaitable and `stop()` supersedes a pending start.
- Disposal cancels by default, settles queued wrappers, waits active work and
  notifications, and cleans partial initialization. Explicit drain mode completes
  accepted work without admitting further discoveries. Repeated calls share a promise.
- Pipeline hooks receive the crawl AbortSignal. Context-scoped logging isolates
  simultaneous downloader instances without cloning request functions or agents.
- The real-process lifecycle harness checks both downloader implementations,
  cancellation versus draining, queued cancellation, cooperative hook cancellation,
  failed initialization, logger isolation, and rejection of submissions after close.
- Build and 281 tests pass. Both lifecycle and downloader runtime checks pass on
  Node 22.13.0; real-process tests also exercise Node 24.18.0.

## Worker stabilization in progress

Worker boundary validation now checks completion ownership before changing load
or settling tasks, validates log method names and payload arrays, and isolates
consumer logger exceptions. Worker channel access requires two distinct actual
MessagePorts. Deterministic regression tests cover forged/duplicate completions,
malformed logs, and throwing loggers; build and all 283 tests pass on Node 24.18.0.
Worker readiness now means pipeline initialization has succeeded. Dispatch waits
for readiness; initialization errors, early exits, deadline expiry, and partial
factory failures terminate the pool and settle startup/queued promises. The
startup deadline defaults to 30 seconds and is configurable through pool options.
Disposal during initialization settles readiness, including cancellation from the
multi-thread downloader while a worker initialization hook is waiting indefinitely.
The new tests cover pool failures and actual default-worker initialization failures.
Build and all 289 tests pass on Node 24.18.0; the expanded real-process lifecycle
harness also passes on the exact Node 22.13.0 minimum.

Optional `workerPool.taskTimeout` bounds dispatched tasks. Expiry retires the
affected worker and rejects its assigned tasks; queued work continues on healthy
workers and is never replayed from a failed worker. Message-decoding errors on
all three channels follow the same failure path. Termination promises are shared,
task timers are cleared on settlement/disposal, and temporary shutdown listeners
are removed on all close/exit/deadline paths. `shutdownTimeout` controls the idle
worker close grace period. Deadline values are validated before workers spawn.
Build and all 296 tests pass on Node 24.18.0. Lifecycle and downloader smoke
checks pass on Node 22.13.0. Decoding tests inject Node's documented `messageerror`
event because actual deserialization failures depend on runtime internals.

Worker envelopes now carry the exported `WORKER_PROTOCOL_VERSION` (1). Control,
completion, and log version mismatches retire the sending worker; built-in workers
validate parent task/control versions too. Missing versions reject startup rather
than silently accepting old custom workers. Build and all 303 tests pass on
Node 24.18.0, including incompatible startup/result/log/control messages. The
versioned custom-worker and built-in downloader smoke checks, plus lifecycle
checks, also pass on Node 22.13.0.

Downloader transport now uses `WireResource` in both directions. Encoding removes
runtime URI/host and DOM fields, retains transferable body ownership, and copies
cloneable metadata. Decoding validates required strings, finite numeric fields,
encoding, body representation, optional redirects/discard flags, and the metadata
container before reconstructing URI instances. Returned child batches are decoded
before admission. Build and all 318 tests pass on Node 24.18.0; real workers verify
URI methods and nested metadata, and unit cases cover binary view offsets and
malformed snapshots. Lifecycle and downloader smoke checks pass on Node 22.13.0.

Worker disposal now sends `Cancel` for active/initializing pools. Built-in workers
expose a thread-local pipeline AbortSignal, scope cancellation checks through the
crawl context, stop accepting tasks, and await active hooks before acknowledging
channel shutdown. Parent task promises settle immediately; pool disposal waits for
channel closure or the configured grace deadline before termination. The real
lifecycle harness verifies a worker hook writes a cleanup marker after cancellation
and before disposal returns, without publishing the resource. Existing stalled
worker/disposal tests exercise the forced fallback. Build and all 318 tests pass
on Node 24.18.0; expanded lifecycle checks pass on Node 22.13.0.

## Remaining implementation and release gates

Buffered publication now uses a same-filesystem staging directory and renames
only after writing and checking cancellation. Failed writes, failed renames, and
cancellation before publication clean staging while preserving prior destinations.
Timestamp updates apply to staging; epoch-zero timestamps are supported. Real
filesystem tests verify these guarantees, binary view bounds, and absence of
staging leftovers. Build and all 324 tests pass on Node 24.18.0; lifecycle and
downloader smoke checks pass on Node 22.13.0. This completes only the buffered
publication foundation: multi-file transactions, streaming/local-copy staging,
save policy unification, and symlink containment remain to be addressed below.

Buffered output containment now resolves the configured root, checks directory
components before staging and publication, and rejects directory symlinks below
that root. Configured root aliases are supported; destination-file symlinks are
replaced without following their targets. Tests exercise built-in save handlers,
nested symlink escape attempts, root aliases, final-file links, and lexical escape
before directory creation. The documented trust assumption excludes hostile
concurrent directory replacement. Build and all 328 tests pass on Node 24.18.0;
lifecycle and downloader smoke checks pass on Node 22.13.0. Streaming and local
copy paths still require the same publication and containment integration.

Local streaming-file copies and streaming URL mounts now use staged publication
with the same output containment. `PipelineExecutor.shouldSaveResource` shares
the buffered save-policy logic, and local copies invoke it after copying but
before publication. Tests cover both sources with overwrite, skipSave,
ifModifiedSince, partial-copy failure, cancellation, and symlinked output
directories. Build and all 340 tests pass on Node 24.18.0; lifecycle and downloader
smoke checks pass on Node 22.13.0. HTTP streaming, unified resource outcomes, and
parent-owned cleanup for forcibly terminated writers remain outstanding.

HTTP streams now write to staging and recheck the existing-resource save policy
before publication. Timestamp updates target staging, preserving cached mtime on
skipSave and 304. Failed/cancelled transfers await their file pipelines before
cleanup; range retries await prior pipelines before reusing staging. Request
headers are copied before adding range state, and legacy manual retry timers have
been removed in favor of Got's configured policy. Build and all 344 tests pass on
Node 24.18.0. All 19 conditional/streaming tests also pass on Node 22.13.0,
including truncation, cancellation, timeout, skipSave, 304, range resume, ignored
ranges, and interrupted retries. Registry/outcomes and parent-owned cleanup
for forcibly terminated writers remain release gates.

Resource normalization now runs between individual before-download,
after-download, and save hooks, matching the download chain. Save-policy checks
also normalize their input. Twelve regressions cover every chain with URL mutation,
structured-cloned resources, and invalid canonical fields that must reject before
the next hook. Build and all 356 tests pass on Node 24.18.0; all twelve regressions
also pass on Node 22.13.0.

Optional `maxResources`, `maxQueuedResources`, and `maxConcurrency` now bound
admissions, waiting tasks, and downloader concurrency. Queue overflow is rejected
synchronously with an observable `ERR_CRAWL_LIMIT` status, avoiding recursive
producer deadlock and allowing later resubmission. Duplicate submissions consume
no additional admission budget. Tests cover active-parent discovery, later queue
resubmission, total limits, option validation, initial/setter concurrency, and
automatic adjustment clamping. Build and all 360 tests pass on Node 24.18.0; the
four new budget tests pass on Node 22.13.0. Byte/resource-size limits and an
evidence-led review of the adjustment heuristic remain outstanding.

Failed download, processing, and save attempts now return a failure result in
both downloader implementations and do not increment downloadedCount. The queue
wrapper releases the original canonical URL reservation only after failure settles,
allowing explicit retries while preventing active duplicates. Worker primitive
throws become explicit errors, including `throw undefined`. Real-process tests
exercise download/process/save/falsy failures, preserved output absence, retries,
and successful deduplication in both modes. Build and all 361 tests pass on
Node 24.18.0; the eight real-process scenarios pass on Node 22.13.0. A complete
registry with alias ownership, destination conflicts, streaming success counts,
and explicit terminal outcomes remains outstanding.

The [TypeScript 7 audit](typescript-7-audit.md) retains TypeScript 6.0.3 for
0.10.0. TypeScript 7.0.2 compiled the tracked snapshot and passed runtime smoke
checks, but locked ESLint/Jest tools require the legacy TypeScript API and exclude
version 7. Five warmed compiler-only samples show a 7.251s versus 1.509s median,
with lower peak process RSS for TypeScript 7. A dual setup adds about 29 MiB of
compiler files while retaining TypeScript 6; it is not adopted for this release.
Recorded evidence distinguishes compiler package size from full installation size.
Test-runner selection remains a separate pending audit.

- Remaining worker cleanup/stress verification.
- Safe staged publication for all sources, uniform existing-file policy, path and
  symlink containment, resource registry/outcomes, and configured admission budgets.
- Evidence-led test-runner comparison and final tooling validation.
- Clean-install graph/size report for development, ordinary consumers, and consumers
  without optional dependencies. Preserve the Undici size rationale and distinguish
  repository overrides from consumer installations.
- Balanced benchmarks, leak and worker stress tests, and measured optimizations.
- Packed-package/declaration checks on Node 22.13/22/24/26, complete migration notes,
  and final requirement-by-requirement verification. No tag or publication.

## Resource byte limits

Optional `maxResourceBytes` rejects oversized buffered HTTP responses, decompressed
HTTP streams (including resumed offsets), local files, URL mounts, and normalized
hook bodies. Failures use `ERR_RESOURCE_SIZE_LIMIT`; worker error records preserve
its code, limit, and actual byte count. Existing destinations survive failed
staging and explicit retries remain possible. This is a logical resource-body
limit, not an aggregate heap limit; parsing and serialization can allocate more.
Build and all 372 tests pass on Node 24.18.0. Eleven real HTTP/filesystem limit
tests and the expanded ten-scenario failure/retry harness pass on Node 22.13.0.
Aggregate buffered-byte accounting remains a separate release gate.
