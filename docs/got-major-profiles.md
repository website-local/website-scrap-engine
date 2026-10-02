# Got 13–16 profiles and final comparison — 2026-10-02

Follow-up: [engine regression investigation](engine-regression-investigation.md)
identifies a dependency-layout confound in this comparison: baseline dependencies
were physical directories, while candidate packages used symlinks. Preserve the
measurements below as historical results, but do not attribute their full baseline
gap to engine code. The follow-up includes aligned layouts and further ablations.

No Got version meets the strict all-suite improvement target against 0.9.1.
Got 14 is the strongest compromise in this run: it improves the markup cases and
has a smaller single-thread streaming regression than Got 15/16. Got 16 wins
buffered workloads. Got 13 is best for single-thread streaming but loses on
single-thread buffered work and worker markup. The project remains on Got 16;
this comparison does not silently change the dependency or enable native mode.

## Retained targeted fix

Worker discoveries were converted to transport objects, their metadata deeply
cloned, and their fields validated before duplicate URLs were discarded. Now,
eligible bodyless duplicates are discarded before that conversion. All discoveries
still count toward configured limits, actual payloads retain validation, and
byte-accounted/depth-ineligible cases keep their original behavior. Unused duplicate
metadata no longer has to be cloneable. A failed conversion does not reserve the
URL: hooks may catch it and submit a corrected resource.

Matched Got 13 CPU profiles (five samples plus warm-up, two workers per downloader)
show these whole-profile self times, summed across parent and workers:

| Function | Before | Retained fix |
| --- | ---: | ---: |
| prepareResourceForClone | 83.42 ms | 8.81 ms |
| assertWireResource | 50.17 ms | 22.82 ms |

Together, these sampled costs fall about 76%. They are not percentages of crawl
wall time. The final paired worker-markup median changes from 569.47 to 567.07 ms
(-0.4%), which is too small to establish an overall elapsed-time gain. Startup,
module loading, parsing and other processing remain substantial. Pools still
initialize once per downloader and survive until disposal.

The single-thread profile was dominated by HTTP/socket and filesystem work. Its
sampled inclusive `getRetry` time was similar on 0.9.1 and current Got 13 (about
250 and 257 ms across the profiled buffered runs). It did not support removing
more resource/output checks to fix the HTTP gap. The retained runtime change only
executes for worker discoveries; single-thread before/after variation is a useful
control for noise, not a claimed benefit or regression caused by this patch.

An experiment skipped inapplicable built-in processing hooks and synchronous
promise turns. Its broad elapsed-time gains did not repeat, so it was removed.
Both its matrix and the four-way isolation run remain in the artifact directory.
The final table below uses the smaller retained patch on every Got version.

The additional `getRetry` typing adjustment makes its promise-response contract
explicit to Got 13's overloads. It emits no new request options. All four majors
now pass source typechecking.

## Final version matrix

Median total milliseconds, lower is better. Eighteen samples per case plus one
discarded warm-up, Node 24.18.0 on Linux, concurrency eight, two workers when used.
Every sample creates, initializes, crawls and disposes a downloader. Six variants
run together: 0.9.1, pre-fix 0.10/Got 13, and the four fixed versions. Variant order
rotates and reverses by complete rotation blocks; every variant occupies every
position equally. Explicit GC runs between samples. Profiles, builds and tests
run separately from benchmark timing.

| Workload | 0.9.1 | 0.10 Got 13.0.0 | Got 14.6.6 | Got 15.1.0 | Got 16.0.0 |
| --- | ---: | ---: | ---: | ---: | ---: |
| SingleThreadDownloader/buffered | 73.71 | 81.00 | 73.56 | 78.13 | 71.02 |
| SingleThreadDownloader/streamed | 110.43 | 112.20 | 115.96 | 121.22 | 125.63 |
| SingleThreadDownloader/local | 14.96 | 14.34 | 14.41 | 14.52 | 14.10 |
| SingleThreadDownloader/markup | 284.09 | 239.42 | 231.00 | 236.01 | 235.87 |
| MultiThreadDownloader/buffered | 480.82 | 400.80 | 383.25 | 406.89 | 356.70 |
| MultiThreadDownloader/streamed | 158.95 | 116.31 | 114.16 | 118.79 | 122.86 |
| MultiThreadDownloader/local | 354.21 | 282.13 | 268.54 | 266.87 | 260.38 |
| MultiThreadDownloader/markup | 549.00 | 567.07 | 541.00 | 562.87 | 542.63 |
| mdn-local/replay | 1302.93 | 1253.75 | 1268.77 | 1228.33 | 1222.03 |

The single-thread streaming differences against 0.9.1 are +1.6%, +5.0%, +9.8%
and +13.8% for Got 13 through 16. Got 13 also regresses single buffered (+9.9%)
and multi markup (+3.3%). Small differences remain noisy, and absolute timings
varied between runs. These results are measurements, not guarantees of a fixed
ranking on other workloads or hosts. There is no aggregate pass.

All four final builds have identical compiled engine hashes. Only Got and its
associated transitive dependencies change; p-queue remains 9.3.3 in 0.10.0. The
0.9.1 baseline uses p-queue 8.1.1 and Got 13.0.0. Got 14/15 were installed only in
isolated local artifacts, with scripts disabled; no tracked dependency was added.

Synthetic workloads retain all four cases and both downloader modes, checking
file counts, request counts and output hashes. MDN retains the actual
SingleThreadDownloader and current mdn-local lifecycle, with 12 fixed saved HTML
acquisitions at depth zero and network disabled. It is a processing/persistence
replay, not a live MDN HTTP crawl, so its differences should not be attributed to
HTTP transfer performance or workers. Every MDN result has SHA256
`d830e9ccad60e88c1ed9976a881c9c2b844b17003945eac72b3775963cbfba05`.

## Validation and reproduction

The retained patch passes the build and 447 tests in 38 suites. Additional real
Node checks against each of Got 13, 14 and 15 pass smoke downloads, cancellation
and drain, failure/retry, outcomes, buffer budgets and discovery behavior. The
regression scenarios include unused non-cloneable duplicate metadata, discovery
limits counting duplicates, and corrected resubmission after serialization fails.

[Evidence JSON](evidence/got-major-matrix.json) includes all six variants, ranges,
source/compiled fingerprints, profile totals and validation details. Raw artifacts
remain under `artifacts/wse-got-matrix-20261002/`:

- `profiles-before/`: 0.9.1 and Got 13 single buffered/local and worker-markup profiles.
- `synth.json`, `mdn.json`, `profiles-after/`: the combined experiment, not final code.
- `isolate-synth.json`, `isolate-mdn.json`: the separate worker-only/hook-dispatch comparison.
- `final/`: final six-way timing, profiles, exact dependency snapshots, runtime logs and fingerprints.

Reproduce the final full matrix from the repository root:

```bash
bash artifacts/wse-got-matrix-20261002/final/measure.sh
```

That script sources the allowed Node/temp/cache environment, then runs the
synthetic and MDN suites serially against their matching engine/lifecycle
snapshots. Keep the MDN replay in future comparison gates.
