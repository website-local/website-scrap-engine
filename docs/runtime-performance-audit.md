# Runtime performance audit (in progress)

The release still needs final measurements after remaining runtime work. These
are measurements of `6041237` against a clean, matching-lock build of tag 0.9.1
on Node 24.18.0. [Raw evidence](evidence/runtime-baseline.json) includes all samples.

## Reproducible workloads

`node --expose-gc scripts/benchmark-crawl.mjs BASELINE/lib/index.js lib/index.js`
runs buffered HTTP, streamed HTTP, buffered local files, and HTML/CSS/SVG discovery
and rewriting in both downloader modes. Each case discards one warm-up, then takes
five samples with alternating version order. Output paths and complete file
contents must hash identically across versions, modes, and samples; binary bytes,
HTTP request counts, errors, terminal outcomes when available, and absence of
staged files are also checked. Concurrency is eight; worker count is two. The
markup case produces 96 files, other cases 48. Binary payloads are 64 KiB,
streamed payloads 256 KiB. Default concurrency adjustment is off in both versions.

Initialization, crawl, disposal, total elapsed time, process CPU, sampled process
RSS, and parent event-loop p99 are recorded. The baseline started workers lazily;
the new readiness contract moves work into initialization, so crawl-only timings
are not comparable. Total time includes disposal. Memory samples include worker
RSS but do not isolate worker heaps; 10 ms sampling can miss short peaks. Imports
are warmed, output directories are fresh, local input is cached, and networking
uses loopback. This is not a WAN throughput or cold-storage benchmark. Filesystem
artifacts were on `artifacts`, not the source checkout's mounted drive.

| Workload | Mode | 0.9.1 median total ms | 6041237 median total ms | Change |
| --- | --- | ---: | ---: | ---: |
| Buffered HTTP | Single | 136.3 | 153.8 | +12.8% |
| Buffered HTTP | Worker | 523.3 | 585.8 | +11.9% |
| Streamed HTTP | Single | 139.5 | 205.4 | +47.2% |
| Streamed HTTP | Worker | 292.3 | 721.6 | +146.9% |
| Local buffered | Single | 24.4 | 47.8 | +95.9% |
| Local buffered | Worker | 433.5 | 503.1 | +16.1% |
| HTML/CSS/SVG | Single | 417.1 | 560.3 | +34.3% |
| HTML/CSS/SVG | Worker | 757.4 | 940.4 | +24.2% |

These regressions are being investigated, not accepted as a completed performance
gate. Streaming runs perform their writes in the parent: waiting for otherwise
unused worker readiness adds startup cost (median 476.9 ms in the new worker
streaming case). Staging, containment checks, outcome/ownership tracking, repeated
normalization, and publication RPC are additional candidate costs. Follow-up
measurements must isolate them before claiming an optimization. Samples are short
and subject to host load; repeat affected cases when attributing differences.

## p-queue decision

`scripts/benchmark-queue.mjs` compares the locked p-queue 8 and 9 implementations
with a paused queue, concurrency 32, full completion/idle checks, one warm-up and
five alternating samples. Median enqueue-to-idle time for 20,000 immediate tasks
was 84.5 ms versus 66.2 ms; for 5,000 setImmediate-yielding tasks it was 22.6 ms
versus 25.6 ms. These synthetic microbenchmarks do not represent crawl throughput,
but do not explain the much larger filesystem/startup regressions. Retain p-queue:
pause/start, concurrency changes, idle/pending state and queue cancellation are
already integrated and tested. A replacement would recreate these semantics for
a small dependency-size saving with no demonstrated end-to-end benefit.

The original opt-in adjustment increased concurrency on a stall and decreased it
on a throughput increase. The revised policy below addresses that inversion;
fixed concurrency remains the default.

## Got option retention checkpoint

At `6041237`, the existing `scripts/benchmark-options.mjs` completed 12,000 merges
in 2,108 ms. Retained heap after warm-up changed by -2,616 bytes; hooks remained
singletons and snapshots remained plain without `_init` history. This refreshes
the options-retention regression evidence. It does not establish memory behavior
for long crawls, resource registries, arbitrary hooks, or worker churn; stress
and aggregate-buffer accounting remain separate gates.

## Directory preparation optimization

Output staging previously called mkdir for every configured root and each parent
directory, even when those directories already existed. It now checks existence
using the realpath/lstat calls already needed for containment, and creates only
missing directories. Concurrent creation still tolerates EEXIST and checks the
result with lstat. No directory-trust cache was added; publication still rechecks
directories before rename. The change preserves the staging and ownership policy.

A separate five-sample alternating comparison against `9b1b1b5`, using the same
dependency tree and workloads, produced these median total times:

| Workload | Mode | Before ms | After ms | Change |
| --- | --- | ---: | ---: | ---: |
| Buffered HTTP | Single | 106.3 | 105.3 | -1.0% |
| Buffered HTTP | Worker | 430.5 | 443.4 | +3.0% |
| Streamed HTTP | Single | 125.5 | 129.6 | +3.2% |
| Streamed HTTP | Worker | 477.1 | 486.3 | +1.9% |
| Local buffered | Single | 37.4 | 35.3 | -5.5% |
| Local buffered | Worker | 429.5 | 400.2 | -6.8% |
| HTML/CSS/SVG | Single | 351.6 | 361.0 | +2.7% |
| HTML/CSS/SVG | Worker | 914.3 | 763.2 | -16.5% |

All output hashes matched. The strongest measured gain is worker markup; these
short local workloads do not support a general throughput claim. Host conditions
differ between runs, so compare paired variants within this table, not absolute
times against the earlier release-baseline table. Final release comparisons
remain required.

A separate parent-side filesystem-call probe for 48 local files measured mkdir
calls falling from 96 to 13; realpath rose from 48 to 56 and lstat from 192 to 197
because concurrent initial creation can race. Both versions made 48 staging
allocations, renames and removals. The reduction comes from avoiding redundant
creation, not skipping containment or publication. The build/typecheck and 394
tests passed on Node 24 (one 11-test suite rerun after a Jest cache-read EINVAL);
all 15 output-store tests, including concurrent missing-directory creation, pass
on Node 22.13. [Evidence](evidence/output-directory-performance.json) records the
source fingerprint, raw timing samples and filesystem counts.

## Opt-in concurrency control

The built-in policy now uses elapsed-time-normalized completion rates. With a
saturated queue, zero completions halves the setting; a >20% drop reduces it by
25%. Stable/improving rates (within 5% of the preceding rate) add at most one
slot. Rates between those thresholds hold the setting. Bounds always apply;
without maxConcurrency, initial configured concurrency is the ceiling, raised
only for an explicitly higher minimum. Empty/unsaturated samples invalidate the
comparison, and start/resume resets sampling. Custom callbacks keep their own
metadata. Zero, noninteger, nonfinite and overflowing timer periods are rejected.

The evidence motivating this change is the prior controller's load amplification
on a stalled origin, not a claimed optimal throughput curve. Deterministic tests
cover stalls before the first completion, slowdown/recovery, bounds, unequal
sampling periods, counters beyond 32 bits, independent crawls and pause/reset.
The real-process HTTP harness lets eight requests complete, stalls the origin,
and verifies no growth beyond the load at the start of an isolated zero-completion
interval, reduced future admissions,
and completion of all 48 resources after recovery in both modes. It passes on
Node 24.18, 22.13 and 26.10. The full suite passed 401 tests before the last two
integration cases; a subsequent build/typecheck and all 25 affected tests pass,
covering 403 tests across the runs. Final matrix validation will run the full set.

This remains an opt-in heuristic with explicit tuning tradeoffs. Slow downloads
can reflect large resources rather than congestion, and completed-resource rate
does not measure bytes, latency, or server capacity. Fixed concurrency and custom
policies remain available. No default crawl speedup is claimed from this change.
