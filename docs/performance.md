# Performance for 0.10

The latest working-tree comparison with 0.9.1 establishes **27.6% less elapsed
time for multi-thread buffered HTTP** under the declared paired-control rule.
Multi-thread markup and saved MDN replay pass control stability but show no clear
difference. Six other comparisons remain provisional because their controls fail.
There is no demonstrated universal speedup or strict non-regression guarantee.

## Latest comparison: 2026-10-03

The candidate is the tracked working tree based on `a1f5fb1`, including the retained
worker-result cleanup, compared with the preserved 0.9.1 emitted artifact on
Node 22.13.0. An identical copy of current code provides the control. Shared
dependencies resolve to the same physical packages; the Got 13/p-queue 8 versus
Got 16/p-queue 9 differences are intentional. Source, runtime, dependency and
harness fingerprints are recorded in the
[preserved input evidence](evidence/final-working-tree-performance.json). The fresh
[measurements and host samples](evidence/idle-working-tree-performance.json) record
the run from 08:36:29 to 08:42:35 UTC without pooling earlier samples.
This snapshot predates the HTTP-cache security mitigation described in the
[dependency audit](dependency-audit.md); these figures do not validate that change.
The [release audit](release-0.10.0-audit.md) distinguishes this tree from committed CI.

Negative changes mean less elapsed time. Percentages and milliseconds are medians
of paired differences; the intervals are 95% paired bootstrap intervals. An
interval excluding zero does not override a failed identical-code control.

| Case | Retained rounds / 12 | Elapsed change | 95% interval | Paired change | Control stable? |
| --- | ---: | ---: | ---: | ---: | --- |
| Single buffered HTTP | 12 | +8.14% | +3.51% to +25.64% | +2.192 ms | No |
| Multi buffered HTTP | 10 | -27.61% | -29.60% to -24.83% | -107.340 ms | Yes |
| Single streamed HTTP | 11 | +8.72% | +2.42% to +16.36% | +2.814 ms | No |
| Multi streamed HTTP | 11 | -38.16% | -41.09% to -31.02% | -22.040 ms | No |
| Single local binary | 11 | +29.59% | +21.58% to +42.22% | +2.130 ms | No |
| Multi local binary | 12 | -32.43% | -33.63% to -29.77% | -107.079 ms | No |
| Single markup | 11 | -9.62% | -16.27% to -5.45% | -11.443 ms | No |
| Multi markup | 12 | +1.46% | -1.07% to +3.27% | +6.752 ms | Yes |
| Single MDN replay | 12 | +0.18% | -1.05% to +2.19% | +0.568 ms | Yes |

These are complete small crawls, including initialization, admission and disposal.
They do not establish steady-state throughput. Synthetic fixtures use 12 binary
files (64 KiB buffered/local, 256 KiB streamed) or six markup documents producing
24 outputs, concurrency eight and two workers. The MDN fixture replays three saved
documents with network access disabled.

The single-local percentage corresponds to about 2.1 ms on this tiny fixture.
Lifecycle, accounting and filesystem work have a larger relative cost when the
underlying operation is short. This campaign does not isolate their individual
contributions. Earlier directory experiments counted Node filesystem API calls,
not operating-system syscalls, and did not establish a benefit from lifting more
checks.

## Noise filtering and interpretation

The host initially showed 15–23% CPU use despite a low WSL load average; Windows
process counters identified background Rust compilation. The run started after
three consecutive Windows samples of 1%, 9% and 6% CPU with empty disk queues.
A later post-run sample was 5% CPU with no queued disk I/O. These observations
establish a quiet starting window, not uninterrupted idleness throughout the run.
The workload probes and identical-code controls remain necessary.

This fresh revision-2 campaign took 365.7 seconds, including calibration and
verification:

- Three discarded calibration triplets per suite used 18 fresh processes. Each
  case had 12 bracketing CPU/I/O probes per group, in the real workload context.
  Each metric threshold was frozen at 1.5 times the median of three calibration
  group maxima. This short heuristic has no guaranteed false-positive rate.
- Twelve balanced measured rounds per suite used 72 processes, each with one
  discarded warmup and two observations per case. Process medians were paired
  by round, with 10,000 deterministic bootstrap resamples (seed 123456789).
- A threshold violation removed the entire triplet for that case. Six of
  108 groups were excluded, all for I/O probes. Each case retained 10–12 rounds;
  the raw evidence records every excluded case and round. All functional checks and output hashes passed.
- At least eight rounds were required. The control interval had to include zero
  and fit entirely within ±5%. Faster/slower classification also required both
  current copies versus legacy to have intervals on the same side of zero.

All cases retained enough rounds. Multi buffered HTTP passed control stability
and both current copies were faster than legacy: current's paired change was
-27.61% (95% interval -29.60% to -24.83%). Multi markup and MDN passed control
stability with unresolved effect intervals. Six cases failed the control check,
so their apparent gains or regressions remain provisional. Passing the probe
filter alone does not establish stable workload timing.

The earlier revision-2 campaign retained 11–12 rounds with two exclusions and
only one passing control. Its evidence remains unchanged. The present campaign
has three passing controls; it still does not resolve every comparison.

The separate revision-1 campaign rejected 87/108 groups using idle calibration
and a mismatched group filter. That rejection rate did not demonstrate a more
loaded host. Revision 2 calibrated the same workload context and group statistic
used during measurement; it did not relax the control criterion. Campaigns were
not pooled. Older Node 24.18 results and focused microbenchmarks also describe
different artifacts or workloads: their percentage gains must not be added to
this table.

## Retained changes and defaults

Got remains the default transport. Native HTTP is opt-in with fallback for
unsupported options. Direct writes, cached per-crawl directory preparation and
lazy workers are the defaults; atomic writes, repeated output checks and waiting
for worker startup remain explicit options. See the
[README](../README.md#performance-defaults) and
[migration guide](../MIGRATION-0.10.0.md) for configuration and contracts.

| Area | Retained change | Supporting history |
| --- | --- | --- |
| Request options and bodies | Public Got option snapshots avoid merge-history growth; Buffer views preserve the body contract | [Single-thread fixes](archive/0.10.0-experiments.md#single-thread-performance-fixes) |
| Pipeline and admission | URI reuse, synchronous hook handling and adjacent body-size reuse preserve mutable resource boundaries | [Body accounting](archive/0.10.0-experiments.md#body-accounting), [admission](archive/0.10.0-experiments.md#admission-overall-performance) |
| Workers and publication | Lazy startup, simpler publication completion, direct connection lookup and dispatch batching | [Publication](archive/0.10.0-experiments.md#publication-simplification), [completion](archive/0.10.0-experiments.md#worker-completion), [dispatch](archive/0.10.0-experiments.md#css-worker-dispatch) |
| Small cleanups | Reused composed cancellation signals and shared retry logging; validated worker-result dead branch removed in the current tree | [Simplifications](archive/0.10.0-experiments.md#minor-simplifications), [release audit](release-0.10.0-audit.md) |
| Correctness | Positive eligible retry delays, bounded stale-date handling, refreshed index-file metadata and CSS replacement offsets | [Accepted fixes](release-0.10.0-audit.md#accepted-correctness-fixes), [CSS offsets](archive/0.10.0-experiments.md#css-worker-dispatch) |

The focused dispatch-pool gain of about 44% is not a whole-crawl claim. Retry and
metadata fixes were accepted for correctness despite inconclusive strict
non-regression evidence; that decision remains separate from benchmark status.

## Rejected or deferred experiments

Further directory-check removal and ancestor reuse did not show a reliable crawl
benefit. A combined last-modified-helper experiment did not justify retention.
The range split/includes rewrite was about 28% slower for short headers under
managed heap pressure and showed no longer-list gain; it also added an allocation
for empty input. These experiments are preserved in the
[directory](archive/0.10.0-experiments.md#directory-check-reduction) and
[code-simplification](archive/0.10.0-experiments.md#code-simplification) histories.

Got rollback and automatic native-stream selection did not show a universal
benefit. Some earlier dependency profiles were confounded by physical versus
symlinked package layouts. Parser replacement and queue rewrites remain deferred;
the [dependency audit](dependency-audit.md) records the decisions. No further
speculative optimization is required for the release quality pass. Preserve
ownership, cancellation, accounting and public mutable-resource contracts.
