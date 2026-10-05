# Direct URI API performance

This records the initial symbol-wrapper campaign. See the subsequent
[expanded wrapper comparison](uri-extended-performance.md) for the current
string-field implementation, added APIs and profiling.

Measured on 2026-10-05 with Node 22.13.0, URIjs 1.19.11, and the current wrapper
using a symbol-keyed native URL property. These are direct URIjs-style API calls,
without resource creation, HTTP, workers, DOM parsing, or disk output.

Absolute parsing and path/query/hash mutations improved; authority mutation
regressed. There is no useful universal speedup factor for this mixed API.

| API batch | Operations | URIjs ms | Wrapper ms | Paired time change | 95% interval | Retained rounds | Result |
| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| Absolute construction + serialization | 20,000 | 53.19 | 10.54 | -80.25% | -80.53% to -79.33% | 18/18 | faster |
| Relative construction + serialization | 20,000 | 15.26 | 3.95 | -74.46% | -77.00% to -72.79% | 12/18 | unresolved-control |
| Eight component getters | 50,000 | 32.36 | 30.32 | -6.29% | -7.69% to -3.79% | 18/18 | faster |
| Clone + serialization | 10,000 | 8.91 | 5.32 | -40.62% | -43.38% to -38.14% | 18/18 | unresolved-control |
| Path/query/hash mutation + serialization | 10,000 | 27.89 | 17.76 | -35.55% | -40.37% to -33.47% | 18/18 | faster |
| Protocol/hostname/port mutation + serialization | 10,000 | 14.26 | 49.76 | +261.81% | +243.34% to +269.25% | 18/18 | slower |
| absoluteTo + serialization | 10,000 | 63.60 | 17.71 | -71.51% | -73.21% to -70.22% | 18/18 | unresolved-control |
| relativeTo + serialization | 10,000 | 136.33 | 27.68 | -79.56% | -80.10% to -78.73% | 18/18 | unresolved-control |
| query(true) + JSON serialization | 10,000 | 33.62 | 18.44 | -44.21% | -50.72% to -40.73% | 17/18 | unresolved-control |

Negative changes mean less elapsed time. The percentages are medians of paired
ratios, so they differ from ratios of the displayed aggregate medians. Every
`unresolved-control` result remains inconclusive even where the observed effect
is large. The four classified results passed the identical-code control and
both wrapper copies agreed on the direction.

Authority setters in this wrapper rebuild or reparse URLs; URIjs updates its
component representation. That implementation difference is a plausible cost
source, but this benchmark does not isolate individual setters or prove the
cause. No implementation changes were made to optimize these results.

## Correctness and semantic limits

Each timed case first checked exact output equality over 256 calls spanning
128 varied canonical inputs. Timed batches also consumed and checked result
checksums. Existing instances were prepared outside timing for getters, clones,
mutations, resolution, and query parsing. Mutation cases reused instances and
included serialization. Getter timing included joining the eight returned
components; parsed-query timing included JSON serialization.

The tenth case, query-object assignment, failed its output preflight and was
not timed. For `.query({x: ['1', '1'], flag: 'yes'})`, URIjs emitted
`x=1&flag=yes`; the wrapper emitted `x=1&x=1&flag=yes`. URIjs deduplicates identical
query values by default. The wrapper uses URLSearchParams and preserves them.
The failure log is retained; no unequal-output speed comparison is reported.

The other inputs deliberately avoid documented WHATWG differences such as
encoded dot segments, Unicode spelling and default-port normalization. The
measurements do not establish full URIjs semantic compatibility.

## Fixed paired protocol

- Separate process per API case; URIjs, wrapper, and identical wrapper control.
- Two warmups per variant; three discarded calibration rounds; 18 measured rounds.
- Two observations per variant in each round; six rotating permutations, with
  the second observation reversing the first order.
- Forced GC before each observation, outside timing. No allocation/memory claim.
- CPU probe before/after each observation: four million integer operations.
  A round is excluded if its maximum probe time exceeds 1.5 times the median
  calibration maximum. Filtering never uses measured API performance.
- At least 12 retained rounds; 10,000 seeded bootstrap resamples over paired
  round medians. Control interval must contain zero and lie inside ±5%.
- No retries, added rounds, post-result operation-count changes or threshold tuning.

Host CPU before measurement was 0%, 11%, 15%, with disk queues at zero. The
host was not consistently quiet; results are a controlled local diagnostic.
Some fast batches lasted only a few milliseconds and their controls were
unstable. All excluded rounds and control failures remain in the evidence.

## Reproduction and evidence

- Harness: [scripts/benchmark-uri.mjs](../scripts/benchmark-uri.mjs). It takes
  URIjs entry, wrapper entry, case name, and output JSON path; run with `--expose-gc`.
- [Full observations, controls, host snapshots and input hashes](evidence/uri-direct-performance.json).
- Frozen measured harness, wrapper, URIjs sources, logs and runner:
  `/mnt/e/tmp/wse-uri-direct-20261005/`. The repository harness additionally
  writes structured preflight failures; the measured harness retained that
  failure in its log.

These measurements supplement the earlier whole-crawl tests. They do not
remeasure the prior multi-thread markup regression after the symbol change.
