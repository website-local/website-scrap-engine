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

## Remaining implementation and release gates

- Versioned worker protocol, explicit resource wire contracts, cooperative worker
  cancellation, and remaining cleanup/stress verification.
- Safe staged publication for all sources, uniform existing-file policy, path and
  symlink containment, resource registry/outcomes, and configured admission budgets.
- Evidence-led test-runner comparison; audit TypeScript 7 without forcing an
  unsupported compiler/API migration.
- Clean-install graph/size report for development, ordinary consumers, and consumers
  without optional dependencies. Preserve the Undici size rationale and distinguish
  repository overrides from consumer installations.
- Balanced benchmarks, leak and worker stress tests, and measured optimizations.
- Packed-package/declaration checks on Node 22.13/22/24/26, complete migration notes,
  and final requirement-by-requirement verification. No tag or publication.
