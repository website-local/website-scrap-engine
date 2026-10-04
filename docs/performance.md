# Performance for 0.10

The first focused comparison of final `f057597` against 0.9.1 confirms less
elapsed time for **multi-thread buffered HTTP (-28.94%)** and **multi-thread
local files (-32.42%)**. Multi-thread markup shows no clear difference; five
synthetic controls still fail. The earlier MDN-local comparison also shows no
clear difference. Strict non-regression remains unproven.

On 2026-10-04 the user accepted these results for now and requested that further
runs stop. Benchmarking is paused; this acceptance does not change the measured
confidence intervals or convert failed controls into confirmed results.

## Second independent repeat: 2026-10-04

The same five cases were repeated again at the user's request, with unchanged
pairing, round count and filtering. [Full evidence](evidence/focused-paired-repeat2.json).
All five controls failed; the estimates below are inconclusive.

| Case | Retained / 18 | Elapsed estimate | Control 95% interval |
| --- | ---: | ---: | --- |
| Single buffered | 18 | -10.14% | +2.31% to +15.48% |
| Single streamed | 17 | -5.40% | -8.44% to +3.37% |
| Multi streamed | 18 | -41.88% | -6.29% to +3.52% |
| Single local | 18 | -0.57% | -1.31% to +7.07% |
| Single markup | 18 | -20.15% | -2.35% to +6.51% |

This campaign took **126.5 seconds including host checks/waits**. One of 90
case-round groups was excluded (single streamed HTTP); all output checks matched.
Starts passed at 0–9% CPU with empty disk queues. Post-run samples were 2%, 32%
and 2%, so host activity remained intermittent. Frozen inputs and independent
statistical verification passed. Earlier campaigns remain separate, and the
performance gate remains open; no improvement or regression qualifies here.

## Independent repeat: 2026-10-04

At the user's request, the five failed-control cases were measured again in a
separate fixed campaign. [Full repeat evidence](evidence/focused-paired-repeat.json).
All **18 rounds per case** were retained; none of 90 groups crossed the fixed
CPU/I/O thresholds. All five identical-code controls still failed the ±5% rule.
Negative estimates mean less elapsed time; none below qualifies as a confirmed
improvement or regression in this repeat.

| Case | Elapsed estimate | Paired change | Identical-code control 95% interval |
| --- | ---: | ---: | --- |
| Single buffered | -9.90% | -2.770 ms | -3.87% to +7.55% |
| Single streamed | +3.86% | +1.131 ms | -5.09% to +8.76% |
| Multi streamed | -45.63% | -26.302 ms | -3.97% to +6.44% |
| Single local | +6.96% | +0.583 ms | -4.65% to +6.85% |
| Single markup | -20.39% | -17.532 ms | -4.05% to +7.30% |

The repeat took **106.6 seconds including host checks**. Every start passed three
CPU samples at 0–9% with empty disk queues. After the run, CPU samples rose to
3%, 31% and 20%, with active Node processes. Quiet starts and passing probes did
not establish stable workload timing; the failed identical-code controls remain
decisive. Output hashes/counts/bytes and requests matched, the 32,315 original
input fingerprints were unchanged, and an independent verifier reproduced all
intervals, filtering and classifications.

Pairing, calibration, round count and thresholds were unchanged. Earlier campaigns
remain separate; no samples were pooled and no result was replaced. The five
cases remain unresolved, so this repeat does not close the final performance gate.

## Focused paired follow-up: 2026-10-04

[Results, host samples and harnesses](evidence/focused-paired-remeasurement.json).
This addresses the eight synthetic cases whose fresh-process controls failed.
Negative changes mean less elapsed time; estimates with failed controls remain
inconclusive even when their effect interval excludes zero.

| Case | Retained / 18 | Elapsed change | 95% interval | Paired change | Interpretation |
| --- | ---: | ---: | --- | ---: | --- |
| Single buffered | 18 | -6.44% | -12.24% to -1.13% | -1.527 ms | Failed control; inconclusive |
| Multi buffered | 18 | -28.94% | -30.24% to -26.75% | -103.331 ms | Confirmed improvement |
| Single streamed | 18 | +0.02% | -3.83% to +2.82% | +0.007 ms | Failed control; inconclusive |
| Multi streamed | 18 | -43.82% | -46.25% to -40.99% | -25.900 ms | Failed control; inconclusive |
| Single local | 17 | +5.95% | -0.17% to +16.81% | +0.503 ms | Failed control; inconclusive |
| Multi local | 18 | -32.42% | -33.92% to -31.27% | -107.946 ms | Confirmed improvement |
| Single markup | 17 | -18.65% | -24.70% to -14.35% | -15.804 ms | Failed control; inconclusive |
| Multi markup | 18 | +1.82% | -1.33% to +2.99% | +8.688 ms | No clear difference |

Windows initially showed 10–17% total CPU, empty disk queues and intermittent
activity from other benchmark/test processes. Each case waited for three samples
at no more than 10% CPU and disk queue length one. All starts passed, with observed
CPU between 0% and 6% and empty queues. Post-run samples were 2%, 2% and 14%:
quiet starts do not establish uninterrupted idleness. Host probing ran between
cases, outside timed observations; bracketing workload probes handled filtering.

The pass took **433.5 seconds including host checks/waits**. Each case ran in one
dedicated process, with both APIs warmed twice, three discarded calibration rounds
and exactly 18 measured rounds. Each round alternated baseline/current/control,
then reversed that order for a second observation. Six permutations repeated
three times. Every observation initialized, ran and disposed a fresh crawler,
including worker startup; candidate/control share the same imported current API.
These are warmed complete-crawl measurements, not cold-import timings.

Two of 144 complete case-round groups were excluded using fixed CPU/I/O thresholds
(1.5 times the median of three calibration group maxima). Paired 10,000-resample
bootstrap intervals and the original ±5% identical-code stability rule were
unchanged. Both candidate copies must qualify an improvement. No rounds were
added, pooled or discarded based on crawl times or favorable effects.

Output hashes, byte/file counts and request counts matched across every variant.
All 32,315 original frozen input entries matched before and after the pass; the
new harness/protocol hashes also matched. Independent Python calculations verified
host-start rules, ordering, calibration, exclusions, intervals and classifications.

The single-thread local estimate is +0.503 ms (+5.95%), with an interval crossing
zero and failed control; this does not reproduce a confirmed large slowdown.
Single markup narrowly fails its control (upper bound +5.14%); the threshold was
not relaxed. Five unresolved cases prevent closing the overall gate. These results
also do not retroactively close the earlier allocation-specific latency gate.
MDN was not rerun because its control already passed; its separate result follows.

## Final source versus 0.9.1: 2026-10-04

[Full results, harnesses and fixture](evidence/final-source-remeasurement.json).
Negative changes mean less elapsed time. These are paired medians; they need not
equal ratios or differences of the separate per-version medians.

| Case | Retained / 12 | Elapsed change | 95% interval | Paired change | Interpretation |
| --- | ---: | ---: | --- | ---: | --- |
| Single buffered | 11 | +20.68% | +7.73% to +31.47% | +5.798 ms | Failed control; inconclusive |
| Multi buffered | 12 | -33.70% | -35.96% to -25.31% | -149.465 ms | Failed control; inconclusive |
| Single streamed | 12 | +17.78% | +8.36% to +33.84% | +6.481 ms | Failed control; inconclusive |
| Multi streamed | 12 | -40.94% | -46.68% to -30.50% | -25.337 ms | Failed control; inconclusive |
| Single local | 11 | +42.52% | +21.15% to +50.77% | +3.027 ms | Failed control; inconclusive |
| Multi local | 12 | -33.96% | -39.11% to -28.80% | -135.821 ms | Failed control; inconclusive |
| Single markup | 10 | -17.34% | -36.43% to -7.70% | -19.077 ms | Failed control; inconclusive |
| Multi markup | 12 | -6.06% | -12.29% to +7.91% | -32.489 ms | Failed control; inconclusive |
| Single MDN-local | 12 | -4.93% | -7.66% to +0.36% | -19.769 ms | No clear difference |

The campaign took **421.1 seconds** on Node 22.13.0: three discarded calibration
triplets, then exactly 12 balanced rounds per suite, two observations per process
and one warmup per case. Four of 108 case-round groups were excluded by fixed
CPU/I/O probe thresholds. No timing-based exclusions, extra rounds or pooling
were used. Identical-code control intervals must contain zero and fit within
±5%; both candidate copies must independently qualify a signed effect.

All nine output/hash/count checks passed. Final source hashes and 32,315 frozen
input entries were verified; all 172 baseline emitted files match the preserved
0.9.1 fingerprints. An independent Python calculation reproduced calibration,
exclusions, balanced ordering, bootstrap intervals and classifications.

The synthetic estimates suggest faster multi-thread downloads and single-thread
markup, with about 3–6.5 ms extra in small single-thread binary crawls. Failed
controls prevent confirming those effects. MDN-local's control interval is
-2.75% to +2.73%; its elapsed estimate is -4.93%, with an effect interval of
-7.66% to +0.36%. This supports no clear difference, not a demonstrated slowdown.

The saved MDN page is 101,908 bytes but differs in hash from the deleted earlier
fixture. Its text is preserved in the evidence. The existing emitted MDN lifecycle
is held constant across engines, with imports rebound to each version. This
three-page replay excludes network and does not include the separate stylesheet
used in later optimization experiments. It cannot isolate changes from the older
MDN campaign. These measurements do not assess allocation, RSS or steady-state
throughput, and do not close the earlier allocation-specific latency gate.

## Earlier 0.9.1 comparison: 2026-10-03

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

## Allocation follow-up: 2026-10-03

Retained in `8c7a290`, against `584e07c` plus the inherited worker cleanup:
remove unnecessary awaits, synchronous hook closures and CSS regex captures.
Sampled cumulative allocation fell 21–24% for CSS, about 17% for SVG and
15–23% for combined resource creation across normal/pressure modes. All timing
comparisons lacked enough rounds or failed controls; the quiet-host latency gate
remains open. The candidate passed 531 tests, builds, 15,000 CSS comparisons and
eight crawl-output comparisons. [Evidence](evidence/performance-memory-followup.json).

## CSS scanner and local MDN replay

The CSS scanner was rejected; the trimmed regex remains. Both prototypes matched
51,312 inputs, but the tuned scanner added complexity and only reduced full MDN
sampled allocation by about 1%. All timing controls failed or had too few rounds.
Duplicate-heavy CSS allocation gains do not establish a general benefit.
[Evidence](evidence/css-scanner-mdn.json).

The local MDN workload replays three saved 101,908-byte HTML pages and an extracted
inline stylesheet with network access disabled, concurrency eight and depth zero.
It includes initialization, local acquisition, processing, output and disposal:
four matching files totaling 323,010 bytes. It is a small single-thread replay,
not a full mirror or a representative external stylesheet corpus.

## Markup and path follow-up: 2026-10-04

Retained as `2382067`, against `8c7a290` plus worker cleanup: reuse split path
segments and avoid rewriting unchanged inline styles, while preserving hook
mutations. MDN elapsed time fell **6.11% normally** (95% interval -7.39% to -4.64%)
and **4.66% under pressure** (-6.74% to -0.83%), passing both-copy controls.
Normal link creation qualified as 1.52% faster. Other focused comparisons remain
partly unresolved, including possible pressure CSS regression; these results do
not retroactively close the earlier allocation gate.

Validation: 534 tests, builds, eight crawl-output comparisons, 80,000 resource/path
outcomes per experiment, then 160,000 POSIX/Windows-path and 8,000 HTML/CSS fuzz
cases. [Measurements](evidence/markup-path-followup.json),
[fuzz evidence](evidence/markup-path-fuzz.json).

## Redirect path reuse follow-up: 2026-10-04

Retained as `b260204`: reuse the relative-path helper when saving redirects.
Sampled path allocation fell; no saving-stage speedup was established.
Validation: 534 tests, builds and 100,000 path equivalence checks.
The inline-CSS marker prototype added allocation without a clear MDN benefit
and was excluded. [Evidence](evidence/redirect-reuse-investigation.json).

## Status and query follow-up: 2026-10-04

Retained as `2789de6`, against `b260204` plus worker cleanup: reuse synchronous
status completion, track pending notifications and reduce query-processing
arrays/conversions. Promise, listener ordering/context, disposal and filenames
remain compatible.

| Sampled cumulative allocation | Normal | Managed heap pressure |
| --- | ---: | ---: |
| Synchronous status notifications | -87.79% | -36.82% |
| Asynchronous status notifications | -27.33% | -18.33% |
| Short-query resource creation | -4.76% | -4.16% |
| Long-query resource creation | -21.95% | -15.07% |
| Local MDN replay | -4.62% | -2.52% |

Normal long-query creation qualified as **20.99% faster** (95% interval -24.92%
to -17.49%; 12/12 rounds). The other nine controls failed, including both MDN
modes. Status fixtures exclude resource creation. Validation: 548 tests, builds,
14 compatibility tests also passing on baseline, 80,000 query inputs, 80,000
hashes, 800 listener sequences, 3,000 metadata cases and eight matching crawls.
Empty-metadata cloning prototypes were excluded. [Evidence](evidence/status-query-followup.json).

## Path punctuation investigation: 2026-10-04

All three candidates after `2789de6` were **rejected**. The final candidate reduced
sampled allocation around 31–32% for punctuation/short-query paths normally and
23–25% under pressure. Short-query pressure timing qualified as 28.91% faster
(95% interval -32.51% to -25.72%). Recurring long-query estimates of +5.20% normally
and +4.15% under pressure had failed controls: unresolved regression concerns,
not proven regressions. Neither ordinary paths nor MDN qualified a benefit.

Each candidate passed 550 tests, builds, 325,832 path comparisons in both URIjs
encoding modes and eight crawl-output comparisons. The two extra tests belong
to the experiments; shipping code has 548 tests. Including `~` changed ISO-8859-1
encoding, and removing later hook awaits changed cancellation boundaries; both
were rejected. [All campaigns and sources](evidence/path-punctuation-investigation.json).

Allocation follow-ups use three rotated baseline/candidate/identical-candidate
triplets per mode on Node 22.13.0, 4 KiB inspector sampling including collected
objects, a 128 MiB old-space limit and 4 MiB semi-space. Pressure includes shared
array churn retaining up to 2 MiB. These descriptive samples establish neither
exact allocated bytes nor reduced RSS, peak or retained heap. Short repeated
post-GC checks found no additional sustained growth. Campaigns remain separate;
failed controls are never overridden by favorable effect intervals.

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
