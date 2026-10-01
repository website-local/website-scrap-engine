# 0.10.0 implementation and release audit

This branch prepares **0.10.0**, unreleased. Runtime implementation is complete;
final clean-snapshot, packed-consumer and release-baseline validation is in
progress. Nothing in this audit authorizes a push, tag or publication.

## Requirements and implementation evidence

| Requirement | Implemented result | Evidence and limits |
| --- | --- | --- |
| Drop Node 18/20; support 22/24/26 | Require Node >=22.13.0; CI tests the exact minimum and latest 22/24/26. Publishing uses Node 24 with npm major 12 pinned. | package.json, CI/publishing workflows; final local matrix pending below. |
| Audit dependencies and installed size | Got 16 and p-queue 9 retained; compatible lint tooling updated; log4js is an optional peer. The default consumer avoids its eleven-package tree. | [Dependency audit](dependency-audit.md), [raw installation measurements](evidence/dependencies.json). Final package footprint refresh pending. |
| Reassess Undici removal | Retain the development skip-dependency override and packaged declaration shim; remove the fragile declaration-copy postinstall. | Saves about 1.58 MiB in development. Consumers do not inherit root overrides; Cheerio still declares Undici. A parser replacement/fork is not justified by current evidence. |
| Audit Got and its historical Options leak | Use public Options.toJSON snapshots, remove url before normalizing options, and avoid reusing Options instances. Preserve hooks/agents and handle Got 16 Uint8Array bodies with a Buffer view. | scripts/benchmark-options.mjs reproduces the old history growth when given Got 13 and checks 12,000 new merges. [Retention checkpoint](evidence/runtime-baseline.json); transport/retry tests. |
| Audit p-queue and concurrency | Retain p-queue. Correct the opt-in controller's inverted response: bounded gradual growth, backoff on stalls/slowdown, elapsed-time sampling and reset on resume. | [Runtime audit](runtime-performance-audit.md), queue microbenchmarks, deterministic sampling tests and stalled-origin harness. Fixed concurrency remains the default; no universal throughput optimum is claimed. |
| Harden tests and select a framework | Retain Jest; add strict source/test typechecking, local deterministic fixtures and real-process worker/transport tests. | [Runner audit](test-runner-audit.md): five warmed samples favored the existing runner. Native ESM mocking and migration costs did not justify replacement. |
| Audit TypeScript 7 | Retain TypeScript 6.0.3 and Node 22 typings. | [TypeScript audit](typescript-7-audit.md): TS7 compiles faster, but current lint/test integrations require legacy compiler APIs and exclude TS7. No parallel compiler dependency was added. |
| Normalize Resource and make URI fields required | Runtime Resource URI/host fields are required and repaired at hook boundaries; raw inputs and explicit WireResource snapshots remain separate. | Resource, hook-invariant and worker-wire tests; [migration guide](../MIGRATION-0.10.0.md). Structured metadata survives; unsupported clone values fail explicitly. |
| Make crawl lifetime explicit | Awaitable start, pause/resume, cancellation or explicit drain, cancel-and-await disposal, initialization cleanup and per-crawl AsyncLocalStorage services. | Runtime lifecycle and simultaneous-crawl isolation tests. Hooks receive an AbortSignal; custom code must cooperate or workers are terminated after their grace period. |
| Bound scheduling and buffering | maxResources, maxQueuedResources, maxConcurrency, maxDiscoveredResources, maxResourceBytes and maxBufferedBytes; explicit failure codes and current/peak byte reservations. | Admission/size/ledger tests and 24 real-process byte-budget scenarios in both modes. Limits reject rather than waiting on capacity held by a parent task. |
| Track outcomes and retries consistently | Immutable per-attempt outcome snapshots, separate acquisition/publication state, accurate stream/local success counts and released failed URL reservations. | Forty outcome scenarios, failure/retry tests, redirect-alias ownership regressions. Outcomes retain scalar state rather than bodies/DOMs. |
| Stabilize workers | Versioned task/control/log envelopes, readiness, startup/task deadlines, ownership validation, transport failure retirement, cooperative cancellation and awaited termination. | Worker-pool, channel, lifecycle and real-process tests cover malformed/duplicate/foreign messages, failed startup, queued work, active cancellation and timeout. |
| Publish safely and resolve output conflicts | Same-volume staging, atomic per-file rename, containment/symlink checks, parent-owned task publication and crawl-local destination reservations. | Output tests, forced-worker-failure/allocation-race harness and conflict/retry harness. Confirmed output remains counted after later failure. |
| Improve performance based on evidence | Avoid redundant mkdir calls; reuse full owned local-read chunks while compacting slices; avoid unnecessary Buffer copies and zero-byte/unchanged-body accounting RPC. | [Runtime performance audit](runtime-performance-audit.md) and paired raw samples. Safety/readiness changes have costs; final release-baseline comparison remains required. |
| Investigate architecture and stress behavior | Parent-owned publication and byte accounting, explicit task/child ownership, independent child outcomes and bounded discovery replace implicit cross-thread assumptions. | [Stress evidence](evidence/buffering-and-stress.json), scripts/stress-crawl.mjs and protocol tests. A wholesale pipeline/parser/queue rewrite is not supported by the evidence. |

## Runtime guarantees and deliberate limits

The byte budget counts logical reservations: queued supplied bodies, each active
body's high-water mark, generated output through io.writeFile, and child bodies
awaiting worker-result delivery/admission. The parent owns worker credits and
transfers them into child tasks without double charging. Failed/duplicate/rejected
children release unused credits at parent settlement. Even timeout before the
first worker RPC waits for worker exit before releasing its transferred body.

This is not an exact process-memory ceiling. DOMs, metadata, stream buffers,
codec/transport copies, simultaneous body representations and temporary custom-hook
allocations require additional headroom. A hook-created body is checked after the
hook returns. Custom workers need equivalent accounting for their own allocations.
Streaming resources do not reserve their entire file size.

Children submitted before a later parent failure remain independently eligible
for processing; there is no transactional rollback of child work. A worker crash
can lose a discovery batch that was not yet delivered. Discovery count/byte limits
bound library admission and transport, not arbitrary allocations within hooks.

Publication is atomic per file, not across a redirected resource's multiple files,
and does not promise power-loss durability. A rename already in progress may
complete during cancellation. Parent cleanup covers built-in worker task
publication; direct custom filesystem I/O and initialization-hook writes remain
outside that protocol. Destination ownership is crawl-local, not a cross-process
lock. The configured root is trusted; portable path checks do not defend against
a hostile process replacing directories concurrently.

## Validation checkpoints already completed

- At `20ad94a`, build, full source/test typecheck and **413 tests** pass on Node
  24.18.0. The aggregate-budget cases and pre-RPC timeout cleanup pass on Node
  22.13.0 and 26.10.0; prior checkpoints cover lifecycle, outcomes, discovery,
  publication failures and conflicts on these runtimes.
- Six stress rounds pass on each of Node 22.13.0, 24.18.0 and 26.10.0: **2,400 saved
  resources, 72 successful retry attempts and 240 queued cancellations per
  runtime**, with checked output, zero final byte reservations and actual worker
  exit after every round. Parent retained-heap growth after warm-up was about
  0.49–0.74 MiB, below the probe's 12 MiB allowance. ESM configuration modules are
  cached by Node; this is a bounded regression probe, not a proof against all leaks.
- At `05b4597`, the bounded-read optimization passes build/typecheck, thirteen
  affected size/local-source tests and an exact-output Node 22.13 local fixture.
  Paired local medians improved 11.8% in single-thread mode and 1.7% in worker mode.
- The earlier Node 26 packed checkpoint validated strict declarations, real
  consumer Undici types, absent optional logging peer and both downloader modes.
  That checkpoint predates the final runtime work and is not final package proof.

## Remaining release gates

1. Clean tracked snapshot at `05b4597`: fresh lockfile install and full build,
   tests and runtime smoke on Node 22.13.0, 22.22.2, 24.18.0 and 26.10.0.
2. Refresh clean packed consumers, strict declarations, optional-log4js behavior,
   runtime harnesses and installation footprints after all runtime changes.
3. Repeat the final release-baseline crawl comparison, investigate material
   regressions, and record the retained safety/performance tradeoffs.
4. Finish migration/changelog consistency checks and requirement-by-requirement
   completion review. Keep 0.10.0 unreleased; do not push, tag or publish.
