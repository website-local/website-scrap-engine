# Native URL wrapper performance

For the fully optimized current wrapper versus exact local `master`, see the
[2026-10-05 best-effort engine measurement](master-wrapper-performance.md).
The historical results below describe an earlier wrapper snapshot.

These measurements precede the 2026-10-05 change from a JavaScript private field
to a symbol-keyed property. Whole-crawl performance has not been remeasured for
that change. The subsequent [direct API comparison](uri-direct-performance.md)
measures the symbol-based wrapper against plain URIjs calls.

The later [expanded wrapper report](uri-extended-performance.md) covers ordinary
string fields and additional URIjs APIs. Those direct-call results do not
remeasure the whole-crawl cases below.

The wrapper improved MDN replay and resource creation, but regressed multi-thread
synthetic markup. It does **not** establish overall non-regression. These results
compare this branch with the accepted **0.10 URIjs runtime**, not 0.9.1.

| Case | Paired time change | 95% interval | Retained rounds | Result |
| --- | ---: | --- | ---: | --- |
| MDN replay (3 pages) | -21.99% | -25.38% to -20.45% | 18/18 | faster |
| Resource creation (10,000) | -44.36% | -47.58% to -42.18% | 18/18 | faster |
| Single / buffered | -5.28% | -13.69% to +0.24% | 17/18 | unresolved-control |
| Single / streamed | -3.48% | -10.96% to +0.82% | 18/18 | unresolved-control |
| Single / local | +2.09% | -4.19% to +13.10% | 17/18 | unresolved-control |
| Single / markup | -7.93% | -13.83% to -5.01% | 18/18 | unresolved-control |
| Multi / buffered | -7.51% | -10.54% to -5.75% | 17/18 | faster |
| Multi / streamed | +2.70% | -8.77% to +19.97% | 17/18 | unresolved-control |
| Multi / local | -6.42% | -8.28% to -2.78% | 17/18 | unresolved-control |
| Multi / markup | +22.77% | +19.40% to +27.21% | 18/18 | slower |

Negative values mean less elapsed time. Effects are medians of paired ratios,
not ratios of the displayed per-variant medians in the evidence JSON.
`unresolved-control` means the identical-code comparison failed; even a signed
baseline comparison is inconclusive in that case. The passing results also
require both candidate copies to agree on the direction.

The markup regression occurs during crawl processing: median observed crawl
times were approximately 515 ms (URIjs), 635 ms (wrapper), and 644 ms (identical
wrapper control). Initialization and disposal were similar. This localizes the
observed increase but does not identify its underlying cause.

Retaining 10,000 created resources used approximately 13.73 MB of heap
with URIjs versus 12.51 MB / 12.50 MB with the wrapper and
its control. These are post-GC heap deltas, not total allocated bytes, peak
memory, or a statistical memory gate. Resource timing excludes the subsequent
GC and output fingerprinting; all resource field fingerprints matched.

## Protocol and limits

One fixed campaign per case: two warmups, three discarded calibration rounds,
18 measured rounds, and two observations per variant per round with reversed
order. Each case used URIjs, the wrapper, and an identical wrapper control.
Rounds exceeding 1.5 times the median calibration-group maximum for independent
CPU or filesystem probes were discarded as complete groups. At least 12 rounds
were required. Intervals use 10,000 seeded bootstrap resamples. A control passes
only if its 95% interval contains zero and lies inside ±5%. No rounds were added
and no thresholds were tuned after seeing results.

Host CPU samples were **10%, 18%, 14%**, with disk queues at zero. They failed
the quiet-start criterion. The campaign proceeded as a busy-host diagnostic;
the copied protocol’s optional five-minute host wait was not performed. Passing
controls support within-campaign comparisons, but do not make this a quiet-host
release gate. No extra retries were run to improve the result.

All crawl output fingerprints matched across implementations. Synthetic cases
cover buffered HTTP, streamed HTTP, local files, and HTML/CSS/SVG rewriting in
both downloader modes. MDN is a single-thread depth-zero replay of the same saved
101,908-byte document, with network access disabled and bootstrap downloads
omitted. Both variants use the same migrated MDN source. These tests do not
measure a live-site crawl or establish general cold-start performance.

## Evidence

- [Validation and result summary](evidence/native-url-validation.json)
- [Migration and compatibility limits](native-url-migration.md)
- Raw rounds, rejected observations, controls, harnesses and host snapshots:
  `/mnt/e/tmp/wse-native-url-20261004/performance/`
- Input fingerprints: `/mnt/e/tmp/wse-native-url-20261004/fingerprint.json`

The artifact JSON retains inherited field names such as `currentVsLegacyPercent`;
here “legacy” means the 0.10 URIjs baseline. Earlier accepted 0.10-versus-0.9.1
campaigns were neither rerun nor modified.
