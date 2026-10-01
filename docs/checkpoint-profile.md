# Checkpoint profile — 2026-10-01

Follow-up: [native HTTP implementation and measurements](native-http-performance.md)
records the subsequent optimizations, retained MDN gate and remaining regressions.

Checkpoint `d2f8ca5` is committed. No further permissive mode is recommended
from these measurements. The all-suite improvement target against 0.9.1 is
still unmet; the remaining work includes ordinary optimization opportunities.

## Synthetic results

Node 24.18.0, concurrency eight, two workers when used, seven measured samples
per case, one discarded warm-up and alternating variant order. Total time
includes initialization, crawl and disposal. All file hashes, file counts and
request counts passed. Benchmarks ran serially without a profiler; profiles
were separate runs. Same workloads as `scripts/benchmark-crawl.mjs`.

Median milliseconds:

| Mode | Workload | 0.9.1 | Checkpoint | Difference |
| --- | --- | ---: | ---: | ---: |
| Single | Buffered | 73.1 | 75.7 | 4% slower |
| Single | Streamed | 103.7 | 113.3 | 9% slower |
| Single | Local | 17.1 | 17.6 | 3% slower |
| Single | Markup | 282.1 | 247.3 | 12% faster |
| Multi | Buffered | 377.0 | 401.6 | 7% slower |
| Multi | Streamed | 140.4 | 126.5 | 10% faster |
| Multi | Local | 312.1 | 316.2 | 1% slower |
| Multi | Markup | 539.2 | 582.3 | 8% slower |

These results agree with the direction of the previous matrix, but small
differences are noisy. For example, single buffered checkpoint samples range
from 70.0 to 105.1 ms. No aggregate speedup is claimed.

## Existing tradeoffs

Each column enables only that option, except “all three”. Identical checkpoint
code and dependencies are used through option wrappers. Values are medians of
total milliseconds, not sums of phase medians.

| Mode/workload | Defaults | Atomic writes | Strict output checks | Eager workers | All three |
| --- | ---: | ---: | ---: | ---: | ---: |
| Single buffered | 75.7 | 80.9 | 82.6 | 73.5 | 78.9 |
| Single streamed | 113.3 | 115.9 | 122.1 | 119.4 | 116.5 |
| Single local | 17.6 | 18.9 | 18.5 | 18.3 | 22.6 |
| Single markup | 247.3 | 244.3 | 263.3 | 241.7 | 275.1 |
| Multi buffered | 401.6 | 404.7 | 403.5 | 399.1 | 400.4 |
| Multi streamed | 126.5 | 116.6 | 114.4 | 415.7 | 423.0 |
| Multi local | 316.2 | 330.2 | 327.0 | 315.5 | 324.1 |
| Multi markup | 582.3 | 580.2 | 594.3 | 566.1 | 570.4 |

`waitForWorkers` has no effect in SingleThreadDownloader; the single eager
column is a useful indication of run noise. Small apparent improvements from
extra checks are not evidence that those checks make the engine faster.

The clearest result is avoiding unnecessary workers for streamed output:
eager readiness adds about 290 ms. For worker workloads, eager initialization
takes about 282–294 ms and mostly moves that cost out of the crawl phase.
Every sample deliberately creates and disposes a downloader. This measures
cold downloader lifetime, not the cost of another batch using its retained pool.
The pool remains one-shot per downloader; this is not evidence of pool recycling.

Direct writes retain the accepted partial-output/overwrite tradeoff. Cached
directory checks require a stable output tree. Atomic writes and strict checks
can add measurable local/markup costs, but their costs are neither uniform nor
additive. Keep these explicit options for users who need their guarantees.

## Is another permissive mode worthwhile?

An isolated copy of the compiled checkpoint removed only the direct-write
destination `lstat` check. This experiment was never applied to project source.
Eleven samples per case still passed the normal benchmark correctness checks.

| Mode/workload | Checkpoint | Without destination check |
| --- | ---: | ---: |
| Single buffered | 76.31 | 81.92 |
| Single streamed | 114.64 | 113.82 |
| Single local | 17.79 | 14.64 |
| Single markup | 240.07 | 241.42 |
| Multi buffered | 391.86 | 390.18 |
| Multi streamed | 111.70 | 110.96 |
| Multi local | 317.32 | 310.00 |
| Multi markup | 567.59 | 563.06 |

A separate 31-sample single/local repeat measured **16.80 versus 15.46 ms**,
a 1.34 ms median reduction across 48 files (about 8%; paired median reduction
1.19 ms). The first run's larger saving did not fully repeat. Other workloads
show no consistent broad benefit.

Such a mode would permit following an existing destination symlink and
overwriting its target, potentially outside the output root. These fixtures use
fresh output directories and cannot validate that lost guarantee. The measured
gain may matter for a dedicated tiny-local-file workload, but does not justify
another mode to solve the current suite regressions. Keep the check for now.

## Profile findings and next targets

Single profiles cover each workload with nine measured samples plus warm-up.
Multi markup has separate profiles for the parent and all twelve workers
(six downloader lifetimes, two workers each). Unique profile filenames avoid
workers overwriting the parent capture.

Profiles include imports, explicit GC, output hashing and cleanup outside timed
crawls. The following are sampled self times over the entire process, not crawl
percentages, and must not be treated as exact optimization savings:

- Single markup: URI.parse 91.8 ms, URI href 65.7 ms, resource construction
  38.5 ms, save-path generation 37.4 ms and resource/path orchestration 36.8 ms.
  Investigate repeated URI/resource/path work while preserving custom hook
  behavior. This does not require restoring normalization between hooks or
  relaxing resource validity requirements.
- Worker markup: per-worker `internalModuleStat` accounts for roughly 39–69 ms;
  compilation and module evaluation are also prominent. The parent spends
  about 2.7 of 4.5 seconds idle in the uniquely named capture. Reduce the cold
  worker import graph and measure retained-pool batches separately before
  attributing the multi regression to publication RPCs or payload validation.
- Buffered/streamed single profiles contain substantial socket/connect, write,
  scheduling and GC work. The fixture deliberately closes HTTP connections.
  Output fingerprint hashing is prominent outside timing. These profiles do
  not isolate Got as the cause of the regression or justify disabling more
  checks. A transport-focused comparison is the next measurement needed.

The queue microbenchmark measured p-queue 8/9 at 60.5/51.8 ms for immediate
tasks and 17.0/19.3 ms for yielding tasks. The options probe completed 12,000
merges in 825 ms with 38,416 bytes retained growth; the legacy probe reproduced
1,000 retained history entries. These are not overall crawl comparisons.

MDN was not rerun for this synthetic profiling pass. The previous identical-MDN
comparison remains 1,037.9/974.9 ms (0.9.1/checkpoint, bounded replay with current
cleanup). MDN explicitly uses the single-thread downloader; worker costs do not
explain its performance.

## Evidence and reproduction

[Raw samples, wrapper sources and profile summaries](evidence/checkpoint-profile.json)
retain slower samples as well as faster ones. Full CPU profiles and isolated
experiment files are in `artifacts/wse-checkpoint-profile-20261001`.
`tradeoffs` variant order is baseline, defaults, atomic, strict, eager, all three.
`ablation` variant order is defaults, no destination check.

Source `artifacts/wse-perf-fix-20261001/env.sh` for the measured Node and allowed
temporary/cache paths. Run the existing crawl harness with the baseline entry
followed by the five wrapper entries and `WSE_BENCH_SAMPLES=7`. Wrapper source
and subsequent profiling commands are embedded in the evidence. For separate
worker profiles use `--cpu-prof-dir=.../multi-profiles` without
`--cpu-prof-name`; thread IDs in automatic filenames distinguish workers.

This follow-up changes only documentation/evidence. Checkpoint validation remains
426 tests in 36 suites on Node 22.13.0 and the Node 24 build. All benchmark
correctness assertions and queue/options probe assertions passed in this pass.
