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
The test-runner audit below subsequently retained Jest.

- Remaining worker cleanup/stress verification.
- Safe staged publication for all sources, uniform existing-file policy, path and
  symlink containment, resource registry/outcomes, and configured admission budgets.
- Final tooling validation across the complete Node matrix (runner audit complete).
- Refresh packed-install measurements after remaining runtime changes (dependency
  inventory and installation audit complete).
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

## Redirect reservation ownership

Successful redirect aliases now remain reserved if an independent in-flight
request to that target later fails. Aliases use the same fragment and optional
query stripping as ordinary admissions; failed worker results cannot reserve
aliases. Three deterministic regressions cover returned/thrown failures and
query normalization. Build and all 375 tests pass on Node 24.18.0; all three
regressions also pass on Node 22.13.0. This fixes alias retention without retaining
Resource bodies; full terminal outcomes and destination reservations remain open.

## Got 16 binary response regression

The isolated Vitest comparison exposed a real migration bug: Got 16 returns
Uint8Array, while getRetry promised Buffer and incomplete-HTML checks only accepted
Buffer/string. Jest's loose byte-array equality had hidden it. Buffer.isBuffer
assertions and an incomplete-then-complete HTTP fixture reproduced four failures.
The wrapper now creates a Buffer view with the original buffer/offset/length,
preserving bytes without a copy. All 376 tests and the build pass on Node 24.18.0;
all fifteen download-resource tests pass on Node 22.13.0. This finding reinforces
using explicit runtime contract assertions alongside byte-content comparisons.

## Test runner decision and full test type checking

The [runner audit](test-runner-audit.md) compares the full 376-test suite under
Jest and Vitest, including five warmed samples each, minimum-Node compatibility,
whole development install footprints, and a smaller native-runner prototype.
Jest remains selected: its median is 36.730s versus 40.468s for Vitest in the
single-worker experiment. Vitest removes 254 installed packages and 11.35 MiB,
but adds a new runner/bundler dependency and requires a separate typecheck.
Node's native ESM mocking still requires an experimental flag at the minimum.

A standalone TypeScript check exposed mock signature issues beyond runtime
assertions. `npm run check:tests` now checks the complete source/test project and
runs as part of `npm test`; the affected mocks use production callback types.
Build and all 376 tests pass on Node 24.18.0. The complete typecheck and 58 affected
tests pass on Node 22.13.0. The isolated Vitest conversion also passes its separate
TypeScript check after the generic mock and Promise fixture fixes. No runner or
other dependency has been added to the repository.

## Undici shim installation fix

The obsolete postinstall copy assumed Cheerio's Undici alias was nested and did
not ship its source shim in the tarball. It is removed. TypeScript now resolves
the existing development-only declaration shim through the project's paths;
the tarball includes that shim alongside its published source/configuration.
No dependency declarations or overrides changed, and no vendor files are patched.

A clean locked install with scripts disabled builds successfully while the alias's
original declaration remains untouched. A fresh no-lock install hoists the alias
to root node_modules and passes the complete test typecheck too. Main build and
all 376 tests pass on Node 24.18.0. Clean-development typechecking and both runtime
downloader modes pass on Node 22.13.0. Ordinary and omit-optional packed consumers
also pass strict declaration checks and both runtime modes on Node 22.13.0;
their Dispatcher type is explicitly checked to be real rather than the any shim.
The packed snapshot excludes the unrelated local shared-context sketch.

Preliminary clean installed footprints are 95.33 MiB/444 packages for development,
9.17 MiB/62 packages for ordinary consumers, and 8.67 MiB/51 packages without
optional dependencies. The real Undici 7.30.0 package occupies 1,658,921 bytes
versus 5,583 bytes for the existing alias, about 1.58 MiB saved only in development.
Consumers do not inherit root overrides. The broader dependency audit still needs
cold/warm installation, download-size, import-cost, and replacement assessments;
these interim footprints are not a completed release-size audit. Evidence and
packed consumer fixtures are under `artifacts/wse-010-implementation/install-audit/`.

## Compatible development updates

The version audit found compatible minor updates to globals 17.13.0 and
typescript-eslint 8.71.0; both are applied, updating thirteen installed packages
without adding package names. The latter still declares TypeScript >=4.8.4 <6.1,
so the TypeScript 7 exclusion remains valid. Node typings remain on 22.20.4 to
match the runtime minimum instead of exposing unsupported Node 26 APIs.
Build and all 376 tests pass on Node 24.18.0; ESLint and the complete source/test
TypeScript check pass on Node 22.13.0. npm audit reports zero known advisories
for the updated development lock and the ordinary consumer lock at audit time.
This is a registry advisory check, not a guarantee against unknown defects.

## Optional logger dependency simplification

The log4js adapter is opt-in and absent from the default import graph, but an
optionalDependency still installed its eleven-package tree by default. It is
now an optional peer, with the same existing package retained for development
checks. Adapter users explicitly install log4js; the migration guide and README
explain this breaking installation change. No new package name was introduced.

The clean packed default and omit-optional consumer installs both contain 51
packages and occupy about 8.67 MiB. Adding the explicit logging peer yields 62
packages and 9.17 MiB. This saves about 0.51 MiB for ordinary users without any
consumer overrides. The new packed-consumer harness checks peer absence by
resolving from the installed package, and verifies actual adapter file output
when the peer is present. All three variants pass strict declaration checks and
both downloader runtime modes on Node 22.13.0. Build and all 376 tests pass on
Node 24.18.0. The tests and source/consumer snapshots remain separate from the
unrelated local files excluded from packaging.

## Completed dependency and installation audit

The [dependency audit](dependency-audit.md) records runtime/tooling decisions,
clean development and consumer footprints, one empty-cache install plus five
warm reinstall samples per baseline case, compressed registry archive bytes,
package tarball size, fresh-process imports, and duplicate dependency versions.
Its evidence separates the baseline measurements from the final optional-peer
footprints. The final ordinary consumer has the same registry archive integrity
set as the baseline omit-optional installation, totaling 1,789,091 compressed
registry bytes plus the library tarball. The final consumer advisory audit also
reports zero known vulnerabilities.

The initial >10% import timing difference was investigated with alternating runs
and runtime resolution tracing: the gap fell to about 4% and both graphs were
identical. No import-speed benefit is claimed for the logger removal. Cheerio's
Undici cost remains explicit; avoiding it in consumers would need a supported
upstream dependency change or a separately justified parser replacement.
Balanced crawl benchmarks, Got retained-heap/worker stress, and the remaining
resource/output architecture work are still release gates. Packed installation
and declaration checks must be repeated after those runtime changes.

## Consistent resource outcomes

Accepted resources now have immutable last-attempt snapshots in `outcomes`, keyed
by canonical admission URL. Acquisition and confirmed publication counts flow
through a per-task crawl context and validated optional worker progress records.
The map stores scalar data only. Successful streams/local copies now contribute
to downloadedCount; failed/cancelled attempts do not. Pre-download skips and 304
remain distinct from save-policy skips after body acquisition. The latter count
consistently in buffered and streaming paths. Queued and active cancellation,
concurrent success/failure isolation, redirects, and partial publication failures
have explicit terminal states. Retry snapshots increment their attempt counter.

A streaming error callback no longer swallows failures or invokes the success
callback afterward. Supplied empty strings are recognized as bodies across the
download chain. Build and all 380 tests pass on Node 24.18.0. The complete source/
test typecheck, forty real-process outcome scenarios, and ten failure/retry cases
pass on Node 22.13.0. Three additional boundary tests reject negative/infinite
worker publication counts and nonboolean skip flags. Custom direct filesystem
writes require their own reporting; worker crash/forced-termination publication
ownership and destination reservations remain separate release gates.

## Node 26 checkpoint

Node 26.10.0 was downloaded from nodejs.org and checked against its official
SHA-256 manifest. At source commit `b4f8b05`, the build, full source/test typecheck,
all 380 Jest tests, and both runtime downloader smoke cases pass. A clean tracked
snapshot was packed separately, excluding unrelated local source files, and
installed into a fresh ordinary consumer under Node 26. Strict declarations
(including ResourceOutcome and worker progress types), both downloader modes,
all forty outcome scenarios, and import without the optional logging peer pass.
[Checkpoint evidence](evidence/node-26-checkpoint.json) records runtime and package
integrities. This closes the initial local Node 26 verification gap, but final
matrix/packed-consumer checks must be repeated after remaining runtime changes.

## Publication handle foundation

File staging now has an explicit create/publish/cleanup handle. Repeated publish
and cleanup calls share their operations; closing an allocation prevents a late
publication and awaits a publication already in flight. The existing publishFile
wrapper uses this handle, preserving writer/save-policy ordering, containment,
and per-file rename behavior. This enables parent ownership without duplicating
filesystem policy. Build and all 382 tests pass on Node 24.18.0; all twelve output
store tests pass on Node 22.13.0. Worker RPC ownership is still being integrated.

## Parent-owned worker publication

The built-in multi-thread downloader now supplies a dedicated publication port.
Parent task leases allocate staging, validate worker ownership, confirm renames,
and count publications in the parent context. Failed transport waits for worker
exit before removing staged files, including allocation requests still awaiting
filesystem completion. Late or foreign requests cannot publish. Exited workers
are removed from the coordinator's connection set. Direct custom filesystem I/O
and initialization-hook writes remain outside the task protocol.

Build and all 385 tests pass on Node 24.18.0. Five real-process cases cover task
timeout, crash, forced cancellation, confirmed output before a later crash, and
cancellation racing delayed staging allocation; these also pass on Node 22.13.0
and 26.10.0. Cached bytes survive failed writes, staged paths are absent before
settlement, and partial-success counts remain accurate. A final focused run
checks the coordinator and multi-thread integration after cleanup review.

## Destination reservations

Crawl contexts now share a destination ownership registry, keyed by resolved
output path and canonical admission URL. Parent-managed worker publication uses
the same registry as local/streaming output. Conflicts fail explicitly instead
of silently overwriting another resource. Unpublished failure releases ownership;
confirmed publication retains it across later task failure and same-URL retry.
The policy intentionally does not invent new filenames or mutate rewritten links.
Reservations are crawl-local, retain no bodies, and are not a cross-process lock.

Build and all 388 tests pass on Node 24.18.0, including active collisions, root
symlink aliases, independent crawl isolation, and real-process checks in both
downloader modes for failed writes, partial publication, conflicts, and retries.
The real-process conflict/retry harness also passes on Node 22.13.0 and 26.10.0.

## Bounded child discovery and parent failure semantics

An optional positive-integer maxDiscoveredResources caps child submission count
per parent in both modes, including duplicate/queue-rejected submissions. The
built-in worker checks before clone/collection; the parent checks custom-worker
result length before decoding. Supplied child bodies respect maxResourceBytes
before cloning. Shared submission wrappers reject late calls after parent task
completion/cancellation, avoiding silent loss in the worker path.

Children submitted before a subsequent parent failure remain independently
eligible for processing. This preserves existing behavior explicitly and avoids
transactional child rollback or recursive queue deadlocks. Worker crashes can
still lose an undelivered batch. Count limits do not bound arbitrary metadata,
hook allocations, parser state, or aggregate buffering; those remain separate.
Build and all 393 tests pass on Node 24.18.0. Tests include boundary/late calls,
custom-worker oversized batches, and six real-process discovery/failure/body-size
scenarios across both modes.
The six real-process scenarios also pass on Node 22.13.0 and 26.10.0.

## Runtime performance checkpoints

The [runtime performance audit](runtime-performance-audit.md) adds reproducible
five-sample alternating crawl/queue comparisons and refreshes the Got retained-
heap check. The release baseline exposed regressions requiring investigation;
worker startup and staged filesystem work are material costs. p-queue remains
justified; the opt-in concurrency heuristic still needs review.

An isolated output-directory optimization avoids redundant mkdir calls while
retaining lstat/realpath containment checks and staging. Paired samples show local
and worker-markup gains without a >10% regression in other workloads; hashes match
across all cases. Build/typecheck and 394 tests pass on Node 24, with one suite
rerun after a cache-read error; 15 output tests pass on Node 22.13. Final balanced
benchmarks, aggregate buffering, stress, and complete packed/matrix validation
remain required before declaring this release ready.
