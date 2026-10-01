# Profile-guided follow-up — 2026-10-01

The subsequent [engine-only investigation](engine-performance-followup.md)
keeps MDN source constant between variants and assesses the requested all-suite
comparison against 0.9.1. That performance target remains unmet.

Committed the engine fixes as `5e15fc3` and MDN's direct single-thread import
as `9d5359c`. Fresh profiles identified a further MDN cleanup improvement,
committed in mdn-local as `a15c59c`. No worker-pool startup or lifetime change
was made in this follow-up.

## Method

Node 24.18.0, serial benchmark execution, alternating variant order, explicit
GC before samples, one discarded warm-up per case. CPU profiles were collected
separately from the timings below. Synthetic runs used
`scripts/benchmark-crawl.mjs`, five samples, all four workloads and both modes.
Every variant passed file-count, request-count and output-hash checks.

MDN used `scripts/benchmark-mdn-crawl.mjs`, the actual MdnDownloader and lifecycle,
and the saved Using_images document at 12 distinct paths. Depth zero, concurrency
eight, fixed document acquisition, no bootstrap seeding, and network blocked.
This measures HTML processing and persistence, not a full remote archive or
live BCD acquisition. Prepared MDN variants adapt the legacy save-path hook for
0.10 and share the remaining workspace dependencies. That workspace installation
is not the locked MDN dependency tree; build/test validation separately used the
verified locked tree.

Raw timings, checks, profile hashes and source identities are in
[the evidence JSON](evidence/profile-guided-followup.json).
CPU profiles and individual logs remain under
`artifacts/wse-profile-20261001`.

## Measured MDN optimization

The original MDN CPU profile attributed about 2,039 ms inclusive to
`preProcessRemoveElements` across six replay runs. It performed dozens of
separate document searches. Batching its initial independent removal selectors
reduced that sampled cost to 923 ms. Parent removals, positional selectors and
later content mutations retain their original order.

Unprofiled median replay times, milliseconds:

| Run | 0.9.1 engine / original cleanup | Committed engine / original cleanup | Committed engine / batched cleanup |
| --- | ---: | ---: | ---: |
| Seven samples | — | 1181.7 | 1049.4 |
| Five-sample repeat | 1213.4 | 1232.1 | 1084.1 |

This is an 11.2–12.0% improvement over the committed engine with the original
cleanup in these runs. Every replay produced the same 12-file output hash:
`d830e9ccad60e88c1ed9976a881c9c2b844b17003945eac72b3775963cbfba05`.
Standalone old/new cleanup also matched exactly on 83 saved HTML fixtures.

MDN's build and all 251 tests in 24 suites passed. The isolated dependency check
matched 456 installed package versions to the lockfile, with only 38 optional
packages absent. The regression covers overlapping removals, retained article
content, parent removal and later positional rules. Logs are under
`artifacts/mdn-profile-validation-20261001`.

## Synthetic results and remaining costs

Median total milliseconds, including initialization and disposal:

| Mode | Workload | 0.9.1 | Pre-fix 1be0080 | Committed 5e15fc3 |
| --- | --- | ---: | ---: | ---: |
| Single | Buffered | 89.0 | 97.5 | 93.6 |
| Single | Streamed | 106.4 | 138.0 | 119.9 |
| Single | Local | 14.3 | 32.1 | 22.7 |
| Single | Markup | 309.9 | 370.4 | 344.3 |
| Multi | Buffered | 381.4 | 428.4 | 415.8 |
| Multi | Streamed | 148.6 | 462.8 | 450.8 |
| Multi | Local | 327.2 | 352.8 | 342.9 |
| Multi | Markup | 596.8 | 681.8 | 672.3 |

The committed fixes improve on the pre-fix snapshot, but do not eliminate the
0.9.1 gaps. These short fixtures are sensitive to scheduling and filesystem
latency; earlier repetitions are retained in the preceding performance report.

The multi-thread 0.10 measurements include roughly 300 ms of pool initialization
per downloader. Its streamed crawl phase is 138.4 ms versus 138.1 ms for 0.9.1;
the large total-time difference is primarily startup in this fixture. Worker
initialization remains one-shot, with the pool retained until disposal. These
profiles do not justify reintroducing per-batch or per-resource initialization,
and MDN uses the direct single-thread entry.

The CPU profiles identify these remaining investigation areas:

- Markup: URI parsing/resolution and replacement-path construction remain
  substantial. `createResourceWithUris` accounts for about 406 ms inclusive over
  nine profiled runs; `_resolveUri` about 203 ms. Remaining parsing includes
  constructing the relative replacement URI, not just the resource URL.
  General caching would need to preserve mutable hook and URI behavior.
- MDN: DOM traversal remains the largest CPU consumer even after batching;
  link redirection and URI normalization also contribute. No legacy-path or
  redirect-cache change was made without paired evidence.
- Local files: profiles show filesystem waiting and publication/read operations,
  rather than a dominant JavaScript loop. The 22.7 versus 14.3 ms gap remains.
  Containment rechecks, atomic publication and failure cleanup were preserved.
- Buffered/streamed HTTP: socket connection work, Got requests and filesystem
  publication contribute. The fixture deliberately closes connections, so its
  connection cost is not representative of MDN's remote keep-alive traffic.

Profiles also include imports, forced GC and benchmark output hashing outside
the timed crawl. Their full-process percentages must not be presented as crawl
CPU percentages. Further engine changes require isolated measurements of the
candidate, rather than removing correctness checks based on those percentages.
