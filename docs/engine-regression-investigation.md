# Engine regression investigation — 2026-10-02

Got 16 remains the default. This investigation holds Got at 13 to distinguish
engine overhead from dependency changes. The evidence does not establish that
all regressions are resolved.

## What the previous profiles actually explain

Cold worker profiles include substantial module resolution. Across the old
matched profiles, `internalModuleStat` self time was 903.54 ms for baseline and
1134.01 ms for candidate; `realpathSync` was 83.82 versus 122.68 ms. These are
whole-profile CPU sample totals, not crawl wall-time differences.

The previous baseline had physical dependency directories; candidate snapshots
used per-package symlinks. A 16-sample experiment kept 0.9.1 compiled code
unchanged and varied dependency layout:

| Variant | Worker markup median |
| --- | ---: |
| 0.9.1, original physical packages | 572.27 ms |
| 0.9.1, symlinks to original packages | 586.17 ms |
| 0.9.1, symlinks to common package locations | 593.54 ms |
| 0.10/Got 13, common package locations | 596.07 ms |

Most of that experiment's apparent cold-worker gap can therefore occur without
engine changes. This does not prove every previous gap was caused by layout.
Common parser/helper package JS/CJS/MJS files were checked byte-for-byte; this
was not a complete nested transitive-dependency audit. Got 13 and p-queue 8 keep
their original baseline package locations; current engine keeps p-queue 9.

A separate 30-sample diagnostic warmed both workers and their HTML parsers before
timing: baseline 253.28 ms, current 249.83 ms. It supplied two empty HTML bodies
without warming network requests. Pools initialize once per downloader and stay
alive until disposal. Cold setup and steady processing must not be conflated.
MDN uses the single-thread downloader and does not exercise this worker path.

## Engine overhead and retained fix

Bypassing parent publication coordination in a diagnostic reduced warm worker
markup from 249.83 to 230.74 ms. A cold diagnostic reduced 614.27 to 596.92 ms.
This identifies a measurable cost for destination reservations and confirmation
round trips. The bypass is not shipped: it removes cross-worker output ownership
coordination. Starting workers before the first download did not improve the
cold diagnostic and was also discarded.

One concrete duplicate check was found and removed. Built-in writers already
open direct output with `O_NOFOLLOW`, but the publication store lost that
capability at the worker boundary. The parent consequently probed the destination
with `lstat` anyway. The capability now reaches the parent. Generic writers and
platforms without supported no-follow flags keep the explicit check. Atomic
publication and ownership coordination remain intact. The symlink regression
test verifies generic writers fail before writing, no-follow writers fail at
open, and the existing target remains untouched.

An isolated destination-probe ablation did not establish a repeatable elapsed-time
win; this is a removal of demonstrably duplicated work, not a guaranteed speedup.

## Single-thread uncertainty

The previous +9.9% Got 13 buffered gap did not repeat consistently: a 36-sample
diagnostic measured 117.62 ms baseline versus 118.07 ms current. Its paired median
difference was 3.66 ms with an exploratory bootstrap interval of -0.54 to
11.43 ms. Differences of paired medians and marginal medians are distinct.

Changing only p-queue to 8 measured 120.48 ms; omitting the request abort signal
115.91 ms; omitting outcome snapshots 116.33 ms. These experiments do not establish
an exact culprit or justify removing cancellation/outcome behavior. Prior sampled
inclusive `getRetry` times were also similar (~250 versus ~257 ms).

## Aligned full comparison

Node 24.18.0, Linux x64, 16 samples per variant and case after a discarded warm-up,
rotating/reversing variant order, concurrency eight, two workers where applicable.
All four variants use per-package symlinks and common runtime package locations.
The synthetic benchmark includes initialization, crawl and disposal; every crawl
checks requests, output count, content and hash. Times below are medians in ms.

| Case | 0.9.1 | Got 13 pre-fix | Got 13 fixed | Got 16 fixed |
| --- | ---: | ---: | ---: | ---: |
| SingleThreadDownloader buffered | 73.63 | 73.86 | 84.54 | 75.54 |
| SingleThreadDownloader streamed | 103.65 | 107.16 | 113.15 | 118.65 |
| SingleThreadDownloader local | 14.69 | 14.72 | 15.15 | 15.67 |
| SingleThreadDownloader markup | 279.47 | 243.32 | 251.58 | 239.30 |
| MultiThreadDownloader buffered | 389.66 | 325.52 | 315.17 | 297.02 |
| MultiThreadDownloader streamed | 142.99 | 117.67 | 105.36 | 112.26 |
| MultiThreadDownloader local | 328.87 | 250.06 | 245.67 | 229.97 |
| MultiThreadDownloader markup | 548.78 | 580.02 | 559.58 | 555.72 |
| MDN single-thread replay | 1025.91 | 1003.32 | 996.82 | 1001.64 |

The fixed Got 13 worker-markup median is 2.0% above baseline; Got 16 is 1.3%
above. Layout alignment reduces a confound but does not eliminate every gap.
The pre-fix versus fixed single-thread variation is not explained by this
worker-only behavior change, so those cases are repeated below.

MDN is a 12-document saved-HTML replay at depth zero using the MDN lifecycle,
with network disabled. It is not a full live crawl or a transport benchmark.
All variants produced SHA256
`d830e9ccad60e88c1ed9976a881c9c2b844b17003945eac72b3775963cbfba05`.

## Single-thread repeat

32 samples per variant, same balanced ordering and checks:

| Case | 0.9.1 | Got 13 pre-fix | Got 13 fixed | Got 16 fixed |
| --- | ---: | ---: | ---: | ---: |
| buffered | 80.90 | 78.59 | 79.52 | 78.37 |
| streamed | 109.41 | 110.29 | 113.65 | 117.84 |
| local | 14.28 | 14.92 | 14.77 | 14.46 |

Fixed Got 13 buffered is now 1.7% faster than baseline, contradicting attribution
of the full-suite +14.8% result to this patch. Streaming remains 3.9% slower and
local 3.4% slower (about 4.24 and 0.49 ms respectively). Got 16 streaming is 7.7%
slower. These residuals remain unresolved; the data does not isolate their exact
engine cause. In particular, the single-thread control/fix difference is not a
measurement of worker publication overhead.

The evidence supports fixing duplicated work and correcting benchmark layout.
It does not yet justify another permissive mode. A publication-coordination
bypass would require a separate explicit output-ownership tradeoff and does not
address single-thread residuals. Further attribution needs isolated-process
single-thread measurements to separate persistent engine costs from shared-process
JIT/GC and timing variation, followed by profiles of any repeatable residual.

## Validation and artifacts

`npm run build` passed. All 448 tests in 38 suites passed, including remote
publication symlink rejection. Got remains `^16.0.0`; diagnostic ablations are
outside the source tree. No dependency changes are retained.

[Compact evidence](evidence/engine-regression-investigation.json) retains sample
timings, medians, output hashes, ablation summaries and the common-package code
audit. Raw output, diagnostic snapshots and logs are under
`artifacts/wse-engine-causes-20261002`: `aligned-synth.json`, `aligned-mdn.json`,
`aligned-single-repeat.json`, `layout.json`, `single-ablations.json`,
`worker-ablations.json`, `worker-mechanisms.json`, `warm-workers.json`,
`build.log` and `tests.log`. Original profiles remain under
`artifacts/wse-got-matrix-20261002/profiles-before`.
