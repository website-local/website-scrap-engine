# Got 13 rollback experiment — 2026-10-02

Follow-up: [Got 13–16 profiles and final comparison](got-major-profiles.md)
records the targeted worker change and compares all four Got majors.

Reverting Got 16.0.0 to 13.0.0 helps some HTTP workloads but does not meet the
all-suite improvement target against 0.9.1. It also slows several worker workloads
relative to the current Got 16 build. The project dependency is unchanged.

## Controlled comparison

All three variants ran in the same process in alternating order: 0.9.1, current
0.10.0 with Got 16, and the identical 0.10.0 compiled code with Got 13. Each case
has 21 measured samples after a discarded warm-up, with explicit GC between
samples. Tests and profiles did not run concurrently with benchmarks.

The current source checkpoint is `a505ef0`. The two 0.10.0 variants have identical
compiled file hashes. Only the Got package resolution and its associated transitive
dependency tree change; both retain p-queue 9.3.3, Cheerio 1.2.0 and URI.js 1.19.11.
The baseline uses Got 13.0.0 and p-queue 8.1.1. Native mode is disabled throughout.
Node 24.18.0, Linux, concurrency eight, two workers when required.

Timings are median total milliseconds, including initialization, crawling and
disposal. Negative percentage changes indicate less elapsed time.

| Case | 0.9.1 | 0.10 Got 16 | 0.10 Got 13 | Revert vs Got 16 | Revert vs 0.9.1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| SingleThreadDownloader/buffered | 110.98 | 121.78 | 114.80 | -5.7% | +3.4% |
| SingleThreadDownloader/streamed | 134.40 | 138.58 | 133.51 | -3.7% | -0.7% |
| SingleThreadDownloader/local | 15.96 | 15.68 | 16.02 | +2.1% | +0.3% |
| SingleThreadDownloader/markup | 343.04 | 291.39 | 296.96 | +1.9% | -13.4% |
| MultiThreadDownloader/buffered | 442.21 | 343.54 | 373.36 | +8.7% | -15.6% |
| MultiThreadDownloader/streamed | 182.80 | 139.19 | 128.00 | -8.0% | -30.0% |
| MultiThreadDownloader/local | 382.65 | 276.70 | 293.77 | +6.2% | -23.2% |
| MultiThreadDownloader/markup | 659.81 | 660.60 | 677.86 | +2.6% | +2.7% |
| mdn-local/replay | 1195.57 | 1158.12 | 1134.36 | -2.1% | -5.1% |

The synthetic suite verifies identical output hashes, file counts and request
counts across all variants and samples. MDN retains the same single-threaded,
12-page saved-HTML replay and current MDN hooks. Network acquisition is disabled
for that replay; it does not measure live MDN HTTP performance. All MDN output
hashes match `d830e9ccad60e88c1ed9976a881c9c2b844b17003945eac72b3775963cbfba05`.

Absolute timings were higher than the preceding session, so this comparison uses
its contemporaneous baseline rather than the previous report's numbers. Small
differences remain noisy: the single-thread streaming median improves 3.7%, but
Got 13 wins only 11/21 paired samples, with a paired median difference of -0.19 ms.
The stronger worker buffered/local slowdowns each have Got 13 winning just 4/21
pairs. Reverting does not establish a consistent overall improvement.

## Compatibility checks

The unchanged compiled code passed both downloader smoke tests, explicit lifecycle
and cancellation/drain checks, failure/retry checks, 40 outcome scenarios, and 24
aggregate-buffer scenarios plus worker timeout cleanup. These runtime probes are
not a full validation of a production dependency downgrade.

A source typecheck against Got 13 fails with three diagnostics at
`src/life-cycle/download-resource.ts`: its overloads infer a stream/promise union,
which makes the progress listener and awaited response types ambiguous. Therefore
a plain dependency-only revert is not build-ready; the request typing needs an
adjustment before adopting it. No source workaround was used for the benchmark.

## Reproduction and artifacts

Artifacts: `artifacts/wse-got-revert-20261002/`, including `manifest.json`,
`versions.json` (dependency versions and compiled hashes), `synth.json`, `mdn.json`,
`summary.json`, typecheck output and all runtime logs. The isolated Got 13 snapshot
is `got13/candidate/`; its Got symlink targets the retained 0.9.1 installation.
Other direct dependency links target the current locked installation.

```bash
source artifacts/wse-perf-fix-20261001/env.sh
WSE_BENCH_SAMPLES=21 node --expose-gc scripts/benchmark-crawl.mjs \
 artifacts/wse-010-implementation/runtime-audit/baseline-091/lib/index.js \
 artifacts/wse-regressions-20261001/native-final/candidate/lib/index.js \
 artifacts/wse-got-revert-20261002/got13/candidate/lib/index.js
bash artifacts/wse-got-revert-20261002/measure-mdn.sh
```

The MDN script supplies the matching lifecycle for each of those three engines.
Keep both suites together when evaluating a future downgrade or optimization.
