# Focused Node CPU profiling — 2026-10-02

The regression goal remains active. No new permissive runtime behavior has been
retained from these experiments. Got 16 remains the production dependency.

## Reproducible profiling

`benchmark-crawl.mjs` accepts `WSE_BENCH_CPU_PROFILE_DIR`. It uses Node's built-in
inspector CPU profiler at a 250-microsecond sampling interval for each measured
crawl, from initialization through disposal. Fixture preparation, explicit GC,
output hashing and fixture cleanup are excluded. Warm-up is not profiled.
Profiles cover the parent thread only, so use SingleThreadDownloader for complete
single-thread attribution; they do not capture worker execution. Run each engine
in a separate process to avoid shared-process version interactions.

Example (set TMPDIR and cache environment to approved local artifact paths first):

```sh
WSE_BENCH_SAMPLES=8 WSE_BENCH_MODES=SingleThreadDownloader \
WSE_BENCH_WORKLOADS=streamed,local \
WSE_BENCH_CPU_PROFILE_DIR=artifacts/wse-focused-20261002/example \
node --expose-gc scripts/benchmark-crawl.mjs /absolute/engine/lib/index.js
```

Profile timings are diagnostic, not performance acceptance measurements. CPU
sampling does not record every call or measure asynchronous wait duration.
Inspector start/stop work appears as `post` in the raw profiles and must be
excluded from attribution. Profiles and detailed self/inclusive summaries are
under `artifacts/wse-focused-20261002/scoped` and `scoped-summary.json`.

## Initial evidence

Whole-process `--cpu-prof` runs (24 samples, streaming and local) showed expensive
benchmark hashing outside crawl timing. The scoped profiles avoid that confound.
Across eight scoped local runs, engine self samples total 13.83 ms on 0.9.1,
23.85 ms on 0.10/Got13, and 23.95 ms on 0.10/Got16. These are sample sums, not
wall-time regression estimates. Streaming remains dominated by socket activity,
filesystem writes, idle time and garbage collection.

A balanced 24-sample unprofiled experiment tested broad diagnostic bypasses:

| Single-thread case | 0.9.1 | Got16 current | Publication bypass | Request signal bypass |
| --- | ---: | ---: | ---: | ---: |
| Streamed | 133.02 | 133.33 | 132.88 | 137.68 |
| Local | 15.89 | 15.20 | 16.59 | 15.69 |

Times are median milliseconds. The publication bypass replaced allocation and
ownership coordination with recursive mkdir and a direct writer, retaining
publication counting and save policy. The signal bypass omitted the signal only
from Got stream options and is a negative control for local files. Both retain
normal benchmark request/content/hash checks, which passed. Neither establishes
a useful gain, so neither is shipped. Unset byte limits already bypass their
stream transforms; removing those checks cannot explain this unlimited workload.

[Raw ablation timings](evidence/focused-profile-ablations.json) are retained.
Further work should isolate publication path preparation and stream setup costs,
measure changes without profiling, then run the full synthetic and MDN suites.
This checkpoint does not claim regressions have been eliminated.

## Publication path candidate

The next candidate reuses the normalized destination when the canonical root
matches, derives a relative suffix directly for matching root prefixes, and
reuses the canonical destination for reservation identity. This avoids repeated
`resolve`/`relative`/`join` operations without relaxing root confinement, symlink
handling, ownership or cancellation. Other root spellings retain `relative()`.

An isolated 12-sample publication-allocation test (20,000 allocations per sample,
prepared directories, direct/no-follow writers, no file writes) measured 85.68 ms
before and 49.33 ms after, a 42.4% reduction. This is CPU-path evidence, not a
42.4% crawl speedup. The focused 24-sample run measured:

| Case | 0.9.1 | Got16 before | Got13 candidate | Got16 candidate |
| --- | ---: | ---: | ---: | ---: |
| Streamed | 108.91 | 112.79 | 103.04 | 114.52 |
| Local | 14.04 | 14.27 | 14.16 | 14.18 |

The local elapsed difference is small and streaming does not improve in this
run. Full-suite validation is required before claiming any regression resolved.
[Candidate evidence](evidence/publication-path-optimization.json) retains both
experiments. The harness and logs remain under the artifact root above.

The 12-sample full comparison, with all output checks passing:

| Case | 0.9.1 | Got16 before | Got16 candidate |
| --- | ---: | ---: | ---: |
| SingleThreadDownloader buffered | 80.66 | 77.19 | 83.24 |
| SingleThreadDownloader streamed | 103.56 | 107.55 | 121.03 |
| SingleThreadDownloader local | 14.33 | 14.29 | 13.70 |
| SingleThreadDownloader markup | 276.18 | 238.38 | 239.78 |
| MultiThreadDownloader buffered | 400.41 | 308.63 | 304.35 |
| MultiThreadDownloader streamed | 140.07 | 110.63 | 107.22 |
| MultiThreadDownloader local | 332.30 | 227.12 | 220.77 |
| MultiThreadDownloader markup | 568.44 | 567.51 | 550.76 |
| MDN replay | 1042.55 | 998.71 | 1032.58 |

This shared-process run improves local and most worker cases, but single-thread
HTTP and MDN are slower than the pre-change candidate. MDN remains below the
0.9.1 median and produces the same verified hash. The mixed outcome requires an
isolated-process follow-up; the allocation microbenchmark alone is insufficient
for accepting an end-to-end performance claim.

Build passed. The initial full test run passed 449/450 tests and failed the
concurrent-resource outcome assertion (`downloaded: false` versus `true`). The
standalone 40-scenario outcome fixture then passed, as did all 16 tests in the
rerun multi-downloader suite. The initial failure is retained in
`path-tests.log`; no test expectations were weakened to make it pass.

### Isolated-process follow-up

12 balanced rounds, each variant in a fresh process with one discarded warm-up
and one measured sample per workload. Output hashes match across processes.

| Case | 0.9.1 | Got16 before | Got16 candidate |
| --- | ---: | ---: | ---: |
| buffered | 86.20 | 90.38 | 90.37 |
| streamed | 104.05 | 116.26 | 114.60 |
| local | 14.25 | 15.82 | 14.46 |

The candidate matches pre-change buffered performance, improves streaming 1.4%,
and local 8.6% in this run. Together with the allocation-path reduction, this
supports retaining the change, without claiming a stable streaming win. Against
0.9.1, candidate streaming remains 10.1% slower and buffered 4.8% slower; local is
1.5% slower. The regression goal is not met. The process harness and raw results
are `isolated.mjs` and `path-isolated.json` under the artifact root.
