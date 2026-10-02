# 0.9.1 → 0.10.0 simplification audit

The runtime diff changes 44 files (+3,066 / −679 lines). There are worthwhile
simplifications, but deleting the new correctness checks wholesale is unlikely
to recover much performance. The largest architectural cost is worker publication
coordination. The best small changes are cancellation reuse and removal of
avoidable state. This review does not claim new benchmark improvements.

The review covers queue/lifecycle state, worker dispatch and shutdown, publication,
resource transport, configuration, both HTTP backends, limits, logging, and the
small parser/lifecycle changes. References below are relative to this repository;
no local machine paths are needed to reproduce the recommendations.

## Prioritized findings

### 1. Worker publication has too many overlapping owners

References: [coordinator](../src/downloader/worker-publication.ts),
[publication store](../src/output-store.ts), [worker dispatch](../src/downloader/multi.ts).

The pool tracks working tasks and worker ownership; the coordinator tracks task
leases and their connection; the worker client tracks pending RPCs and publication
state; each parent allocation separately tracks publication/cleanup state. Some
of these layers are necessary across a thread boundary, but together they make
successful direct writes pay for an allocation protocol designed to cover atomic
staging, cancellation, worker death, accounting and destination conflicts.

Earlier diagnostic measurements reduced warm worker markup from 249.83 to
230.74 ms when parent coordination was bypassed. That is evidence of a real cost,
**not** evidence that an equivalent refactor will recover the same time. The
bypass removed cross-worker ownership guarantees and was not retained.

Recommendation: make task/publication ownership authoritative in one place and
represent direct versus atomic allocations explicitly. Keep buffered-byte RPC on
the existing channel; another channel or service per feature would add complexity.
Start with the allocation/cleanup interface and typed operation variants, rather
than deleting checks at individual call sites. Preserve the rule that failed
workers must exit before paths and transferred-body credits are released.

Benefit: largest potential reduction in state-machine complexity; possible worker
latency improvement. Risk/effort: high. It does not speed up single-threaded MDN.

### 2. Cancellation is checked and composed at too many levels

References: [hook runner](../src/downloader/pipeline-executor-impl.ts),
[crawl context](../src/crawl-context.ts), [lease creation](../src/downloader/worker-publication.ts).

The executor repeatedly calls both `this.signal?.throwIfAborted()` and
`throwIfCancelled()`. In normal downloader execution those point at the same
signal. The worker coordinator also creates `AbortSignal.any` for every output
allocation even though the crawl signal and lease controller are unchanged for
that task.

Recommendation: centralize the executor/context check in one helper that checks
a second signal only when it is different. Compose the lease's combined signal
lazily on the first allocation and reuse it for all allocations. Do not cache
a caller-specific request signal globally or assume independently supplied
executor/context signals are always identical.

Benefit: fewer objects and repeated checks, smaller hook bodies, no intended
behavioral tradeoff. This is the best first implementation candidate. Its
end-to-end gain still needs measurement; previous complete signal-removal
experiments did not establish a reliable gain.

### 3. Resource handoff performs duplicate validation and metadata cloning

Reference: [prepareResourceForClone / decodeResourceFromClone](../src/resource.ts).

The sender constructs a wire object, explicitly `structuredClone`s metadata and
validates the wire fields. `postMessage` then structured-clones that metadata
again, and the receiver validates before normalization. Eliminating duplicate
bodyless discoveries already reduced this work, but unique resources still take
the full route.

Recommendation: establish one serialization/validation boundary with explicit
ownership of the queued payload. The receiver should retain validation. Consider
removing sender validation for trusted built-in resources and eliminating the
extra metadata clone only after defining whether metadata is snapshotted at
submission or dispatch.

This is **not** a safe deletion as written: the first clone captures nested
metadata before later hook mutations and reports clone errors early. Moving that
boundary changes error timing and potentially snapshot semantics. Existing tests
for clone failures, resubmission, hooks and transferred buffers must remain.

Benefit: potentially fewer graph traversals on discovery-heavy crawls. Tradeoff:
requires an explicit handoff contract; no benefit for MDN's single-thread path.

### 4. Configuration normalization maintains a cache to compensate for repeated work

Reference: [defaultDownloadOptions / mergeOverrideOptions](../src/options.ts).

A configuration can pass through the public default builder, override merging,
and downloader initialization. The code recursively copies configuration,
compares snapshots deeply, maintains a WeakMap, and sometimes constructs another
Got Options object. The cache is careful, but the pipeline is harder to explain
than a single normalization boundary.

Recommendation: distinguish raw configuration from an owned normalized snapshot,
then normalize once per downloader initialization. Avoid a second cache or more
identity heuristics. First document whether caller mutation and Got init hooks
must remain observable at every invocation of the public builder; current tests
and comments deliberately preserve those behaviors.

Benefit: lower initialization/allocation complexity, likely most relevant to
short-lived downloaders. It is not a demonstrated fix for steady HTTP throughput.
Correction after implementation review: the current `adjustConcurrencyPeriod`
upper-bound validation already occurs once; there is no duplicate to remove.

### 5. Retry compatibility introduces an avoidable import cycle

References: [native HTTP](../src/life-cycle/native-http.ts),
[Got download helper](../src/life-cycle/download-resource.ts), [options](../src/options.ts).

Native eligibility imports `beforeRetryHook` from the Got download helper, which
imports the native backend. This works because the reference is used after module
initialization, but couples retry-policy inspection to the complete download
implementation.

Recommendation: move the shared retry logging hook to a small module and re-export
it from its existing public location. Keep native and Got request execution
separate. A generic transport framework or a single giant retry engine would be
more abstraction than this project needs, particularly with Got-specific hook
objects and native full-request retries.

Benefit: simpler dependency graph and easier isolated tests; no claimed speedup.
Native must remain opt-in and retain the newly added bounded retries.

### 6. Outcome tracking imposes an always-on retention policy

Reference: [resourceOutcomes and record](../src/downloader/main.ts).

Each admission allocates a frozen queued snapshot, a running snapshot, and a final
snapshot. The map retains final outcomes for the whole crawl, in addition to the
URL sets and publication reservations. These collections have distinct semantics;
they cannot simply be merged. Nevertheless, always retaining detailed outcomes is
an API policy with a memory cost even for consumers that only need counts.

Recommendation: if large crawls demonstrate pressure here, allow bounded or
opt-in detailed outcomes while keeping aggregate counters. Removing `Object.freeze`
alone reduces enforcement but does not fix retention. Reusing one mutable object
would break the existing stable-snapshot behavior.

Benefit: potentially meaningful retained-memory reduction. Tradeoff: changes the
outcome API's availability/retention contract. Earlier no-outcome timing ablations
did not establish a reliable elapsed-time gain, so this is not a first CPU fix.

### 7. Small dead or duplicated declarations can be trimmed

- `WorkerInfo.closed` is declared but never populated or consumed internally.
- `AbstractDownloader._isInit` is assigned but never read internally; `_state`
  now expresses lifecycle state. The old field predates 0.10 and is exposed in
  declarations, so check external compatibility before removing it.
- Worker dispatch stores richer pending tasks behind a narrower map type and
  repeatedly casts them back. Use the actual stored type to remove casts.
- The default worker URL can be resolved directly relative to `import.meta.url`,
  reducing path assembly and its long explanatory comment.

These are maintainability cleanups, not credible performance fixes on their own.

## Complexity worth keeping

- The 88-line optional buffer ledger: it prevents double charging transferred
  children and releases credits deterministically. Unlimited crawls do not create
  a budget. Removing it would drop a feature rather than simplify its use.
- Worker shutdown acknowledgement, stream closure, exit waiting and bounded
  termination: they address different races. One unconditional `terminate()`
  would lose orderly hook/log/file cleanup.
- Synchronous hook fast paths and lazy parser loading: they preserve measured
  improvements, especially for MDN and binary-only workers. Replacing them with
  unconditional `await` would look shorter while adding scheduling overhead.
- Kernel no-follow opens and cached output-directory preparation: compact,
  useful defaults already replace repeated filesystem probes.
- Resource normalization at the receiving worker boundary: it is already limited
  to the boundary rather than repeated throughout ordinary single-thread hooks.

## Recommended order and validation

1. Reuse lease cancellation signals and centralize duplicate signal checks.
   Keep exported declarations unless their removal is separately approved.
2. Remove the retry-hook import cycle without changing the public export.
3. Evaluate publication lifecycle consolidation with explicit state transitions.
4. Revisit metadata handoff and outcome retention only with an agreed contract.
5. Consider single-pass configuration normalization as a separate API cleanup.

Do not combine these into one large rewrite. For performance candidates, retain
full synthetic and single-threaded MDN comparisons, identical-code controls when
needed, and output hashes. For ownership/cancellation changes, retain the worker
failure, atomic output, discovery, byte-budget and stable-outcome tests.

## Incoming dependency update

Rebased the local branch onto `e354751` (`typescript-eslint` 8.71.0). One lockfile
conflict concerned the transitive `ignore` package; the resolution retains 7.0.11
from the local dependency update alongside the incoming typescript-eslint version.
A clean `npm ci`, `npm run build`, and all 455 tests in 38 suites passed with the
rebased dependencies. Runtime source was not changed as part of this audit.
