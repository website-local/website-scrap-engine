# Current wrapper versus master: best-effort engine measurement

The subsequent [MDN artifact/log probe](mdn-uri-probe.md) adds compatibility fixes
and direct-API optimizations. The engine measurements below predate those changes.

On 2026-10-05, three of ten cases qualified as faster: single-thread markup, multi-thread buffered, and multi-thread local. Seven failed the identical-code control; no case qualified as slower. This is encouraging, but does **not** establish overall non-regression. There is no meaningful single aggregate speedup across these different workloads.

Baseline: exact local `master` commit `1dd221492221db5ceffaf9be4288f94e0c16a0ee` (0.10.0, URIjs 1.19.11). Candidate: the current uncommitted wrapper and integration changes, including the completed optimizations. Node 22.13.0; both engines use one shared dependency tree. This is not a comparison with 0.9.1.

Negative percentages mean less elapsed time. Paired effects are medians of within-round ratios, not ratios of the displayed medians. All unresolved numbers below are descriptive estimates, not validated gains or regressions.

| Case | Master / current median (ms) | Paired time change | 95% interval | Retained | Result |
| --- | ---: | ---: | --- | ---: | --- |
| MDN replay (3 pages) | 324.31 / 285.09 | -12.19% | -14.98% to -10.28% | 16/18 | unresolved-control |
| Resource creation (10,000) | 193.71 / 104.25 | -45.86% | -48.71% to -42.52% | 17/18 | unresolved-control |
| Single / buffered | 27.95 / 25.39 | -10.48% | -18.01% to -0.26% | 17/18 | unresolved-control |
| Single / streamed | 32.36 / 33.44 | +2.02% | -0.79% to +10.53% | 18/18 | unresolved-control |
| Single / local | 8.73 / 8.72 | +0.34% | -3.47% to +2.76% | 18/18 | unresolved-control |
| Single / markup | 90.55 / 85.14 | -7.99% | -11.75% to -3.24% | 18/18 | faster |
| Multi / buffered | 278.76 / 258.65 | -5.95% | -10.40% to -4.46% | 17/18 | faster |
| Multi / streamed | 34.93 / 34.55 | +0.71% | -11.14% to +7.49% | 18/18 | unresolved-control |
| Multi / local | 254.20 / 229.33 | -9.41% | -10.20% to -6.67% | 16/18 | faster |
| Multi / markup | 689.07 / 681.53 | +0.27% | -3.92% to +2.48% | 18/18 | unresolved-control |

## Interpretation

The earlier +22.77% multi-thread markup regression did not recur: this snapshot measured +0.27%, with a −3.92% to +2.48% interval. Its control narrowly missed the limit, so the earlier regression cannot be declared conclusively resolved. The historical campaign used an older wrapper; its percentages must not be pooled with these results.

MDN replay suggests a 12.19% time reduction, and resource creation suggests 45.86%. Both control intervals narrowly exceeded ±5%, preventing a qualified speed claim. The three qualified improvements are 7.99% for single markup, 5.95% for multi buffered, and 9.41% for multi local.

Observed crawl-phase medians account for those qualified gains: single markup 88.17 → 80.50 ms, multi buffered 260.08 → 238.11 ms, and multi local 240.42 → 215.46 ms. These are descriptive phase medians, without separate statistical gates. Worker startup can occur during crawl, so this does not isolate URL processing as the cause.

Retaining 10,000 resources used median post-GC heap deltas of 13.74 MB for master and 11.52 / 11.53 MB for the two current slots, approximately 16% lower. This is diagnostic retained heap, not peak memory or total allocation, and has no statistical memory gate.

## Controls and host conditions

| Case | Identical-current control 95% interval | Control | Excluded rounds (zero-based) |
| --- | --- | --- | --- |
| MDN replay (3 pages) | -5.40% to +2.36% | fail | 3, 11 |
| Resource creation (10,000) | -2.86% to +5.24% | fail | 2 |
| Single / buffered | -8.71% to +7.72% | fail | 17 |
| Single / streamed | -6.49% to +6.01% | fail | none |
| Single / local | -6.93% to +3.16% | fail | none |
| Single / markup | -3.86% to +2.96% | pass | none |
| Multi / buffered | -4.83% to +1.81% | pass | 7 |
| Multi / streamed | -3.80% to +22.73% | fail | none |
| Multi / local | -4.85% to +2.52% | pass | 13, 16 |
| Multi / markup | -4.27% to +5.27% | fail | none |

Host CPU samples (8 logical processors):
- before: 66%, 67%, 83%.
- after-priority: 15%, 5%, 5%.
- after: 13%, 18%, 27%.

Total physical-disk queue length was zero in every host snapshot. These sparse samples do not establish idle conditions during measurement. Multi markup and MDN ran first, followed by the remaining synthetic cases and resource creation. CPU load fell after the priority cases. No quiet-host wait or retry was used.

## Method and reproducibility

- Exactly 3 discarded calibration rounds and 18 measured rounds per case, following two warmups per variant. Each round contains two observations per slot: master, current, and identical current. Six rotating orders and reversed second observations reduce order bias. Cases ran sequentially, with no profiling or concurrent validation work.
- Bracketing CPU and I/O probes exclude an entire round when its maximum exceeds 1.5× the median of calibration maxima. Crawl timing and observed speedup never select exclusions. At least 12 retained rounds are required; all cases retained 16–18.
- Seeded 10,000-resample bootstrap intervals use paired round medians. The identical-current interval must include zero and lie entirely within ±5%. Both current-versus-master intervals must agree in sign for a faster/slower classification. These are per-case intervals, without a multiple-comparison correction; this best-effort campaign is not a final release gate.
- Each synthetic observation creates, initializes, crawls, and disposes a downloader. Imports and caches are warm. Fixtures contain 12 × 64 KiB binary resources, or 12 × 256 KiB streamed resources, or 6 markup documents producing 24 files. Concurrency is 8, configured workers 2. Streamed workloads can bypass worker processing; mode names alone do not imply worker startup in every case.
- MDN is a saved 101,908-byte HTML fixture replayed as three documents, single-threaded at depth zero, with external network access disabled. It is not a live MDN crawl. The master consumer imports URIjs directly because master does not export `URI`; current imports the engine wrapper. Seven source files differ only in those URI import bindings.
- Synthetic request counts and complete output fingerprints were checked for every observation. MDN output fingerprints and resource-field fingerprints matched across variants. All ten cases completed without functional mismatch.
- Master source was checked byte-for-byte against Git; current source against the repository and previously validated package. Source, build, harness, protocol, and fixture hashes are preserved in the evidence; source/build/harness/protocol integrity was checked again after the run. The unrelated `src/shared-context.ts` draft was excluded.
- Setup initially encountered invalid transitive declarations and missing URIjs types/exports in the baseline MDN build. Existing dependencies were shared and baseline imports adapted before timing. Corrected engine and consumer builds passed. Initial setup failures remain in local logs; no timed case was rerun.

Full observations, exclusions, calibration data, both candidate comparisons, host snapshots, dependency versions, source hashes, and harness sources are in [the evidence JSON](evidence/master-wrapper-performance.json). The inherited `currentVsLegacyPercent` field means current versus exact master here. Local builds and logs remain at `/mnt/e/tmp/wse-master-wrapper-20261005`.

This report adds measurements only; runtime source was not changed. Previously completed functional validation remains 706 tests / 47 suites plus build and consumer checks; it was not repeated during timing. Historical results remain in [the earlier report](native-url-performance.md).
