# Native HTTP performance — 2026-10-02

Follow-up: [Got 13–16 profiles and comparison](got-major-profiles.md) measures
the full-compatibility transport alternatives and a targeted worker optimization.

The opt-in native transport beats 0.9.1 in all measured HTTP crawl cases. The
all-suite target is still **not met**: the strict combined native gate failed
single-thread local copying, and the Got-default gate failed single-thread HTTP.
No aggregate pass is claimed. Native mode remains opt-in; enabling it trades
Got's full request API and automatic retries for the supported GET/HEAD subset.

## Paired end-to-end measurements

Node 24.18.0 on Linux, concurrency eight, two workers when required. Each sample
includes downloader initialization, crawl and disposal. One warm-up is discarded;
variant order alternates. Runs are serial, without profiling. Output hashes,
file counts and request counts are checked. Native HTTP cases additionally assert
that the selected backend is actually native. Workers remain alive until disposal;
single-threaded cases never use them.

The native and Got columns come from separate paired runs (21 and 11 samples,
respectively); each has its own 0.9.1 baseline. Differences are median elapsed
time changes, with negative values indicating improvement.

| Workload | 0.9.1 / native ms | Native change | 0.9.1 / Got ms | Got change |
| --- | ---: | ---: | ---: | ---: |
| SingleThreadDownloader/buffered | 69.72 / 49.69 | -28.7% | 80.18 / 83.38 | +4.0% |
| SingleThreadDownloader/streamed | 96.11 / 84.28 | -12.3% | 94.70 / 105.93 | +11.9% |
| SingleThreadDownloader/local | 13.51 / 14.51 | +7.4% | 14.31 / 13.66 | -4.5% |
| SingleThreadDownloader/markup | 269.47 / 191.23 | -29.0% | 267.03 / 231.95 | -13.1% |
| MultiThreadDownloader/buffered | 363.80 / 268.60 | -26.2% | 365.79 / 291.63 | -20.3% |
| MultiThreadDownloader/streamed | 126.84 / 87.08 | -31.3% | 128.02 / 101.28 | -20.9% |
| MultiThreadDownloader/local | 308.36 / 213.49 | -30.8% | 309.12 / 216.14 | -30.1% |
| MultiThreadDownloader/markup | 526.25 / 519.08 | -1.4% | 541.46 / 525.15 | -3.0% |
| mdn-local/replay | 999.23 / 982.64 | -1.7% | 1006.42 / 994.79 | -1.2% |

Synthetic workloads use 48 binary files (64 KiB buffered/local, 256 KiB streamed)
or 24 markup documents with 96 output files. HTTP uses a loopback server.
MDN is the retained **single-threaded saved-page replay**, using the current
mdn-local lifecycle on both versions: 12 fixed HTML acquisitions, maxDepth zero,
no live network acquisition. It measures engine processing with MDN hooks, not
a full live MDN scrape or native transport performance against MDN servers.
MDN output SHA256: `d830e9ccad60e88c1ed9976a881c9c2b844b17003945eac72b3775963cbfba05`.

## Local repeat and profiles

The local case changed direction between combined runs. A separate 61-sample
comparison with all three variants measured 13.818 ms for 0.9.1, 13.914 ms for
native (+0.7%), and 14.063 ms for Got (+1.8%). Both transports use the same local
I/O code. Median crawl phases were 12.382 / 12.159 / 12.305 ms; initialization
was 1.358 / 1.610 / 1.646 ms, and disposal 0.039 / 0.134 / 0.132 ms. Phase medians
do not sum to total medians. This narrows the residual to small lifetime overhead
and variability, but does not supersede the failing combined gate.

Separate CPU profiles covered native local/streamed/markup and a longer local-only
run. Socket connection/write work and URI/markup processing remain prominent;
local engine samples are spread across metadata, pipeline, resource construction,
outcome recording and publication. Whole-process profiles also include import,
explicit GC and output hashing outside the measured crawl. Their self times must
not be interpreted as percentages of measured crawl time. No additional permissive
mode is justified by these profiles.

The options stress probe completed 12,000 merges in 920 ms with 47,624 bytes of
retained growth, passing the bounded-history assertion. The dependency-only queue
probe measured p-queue 8 / 9 medians of 72.44 / 48.03 ms for immediate jobs and
16.18 / 19.49 ms for yielding jobs. The latter remains a dependency microbenchmark
regression; it is not masked by the improved end-to-end worker measurements.

## Validation and reproduction

447 tests across 38 suites passed on Node 22.13.0. The final timeout/redirect
hardening then passed the Node 24 build and 26 focused native/options tests.
Coverage includes certificate-verified HTTPS, redirects, cancellation, timeouts,
body limits, decompression, Got fallback, cached output and atomic failures.
No dependency was added.

Retained artifacts: `artifacts/wse-regressions-20261001/native-final/`:
`gate.json`, `default-gate.json`, `local-repeat.json`, `options.json`, `queue.json`,
`profiles/`, `local-profile/`, and `source-sha256.json`. Earlier rounds remain in
sibling directories. The candidate is a snapshot of `lib/` with locked dependencies;
`native.mjs` enables native in synthetic options. MDN wrappers use the same candidate.

```bash
source artifacts/wse-perf-fix-20261001/env.sh
WSE_BENCH_SAMPLES=21 node scripts/benchmark-regressions.mjs \
 artifacts/wse-010-implementation/runtime-audit/baseline-091/lib/index.js \
 artifacts/wse-regressions-20261001/native-final/native.mjs \
 artifacts/mdn-local-review6-20261001-q27x8arv/probes/en-US/developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Using_images.html \
 artifacts/wse-relaxed-checks-20261001/mdn-current-091/mdn/life-cycle.js \
 artifacts/wse-regressions-20261001/native-final/native-mdn/life-cycle.js
```

For Got, use `native-final/candidate/lib/index.js` and
`native-final/mdn/life-cycle.js` as the candidate paths. The strict runner exits
nonzero if any median is higher; keep MDN in this gate for future optimizations.
