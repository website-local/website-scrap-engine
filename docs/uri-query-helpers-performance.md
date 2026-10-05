# Query helper optimization and parsed-cache experiment

The subsequent [query-write/base-reuse pass and upstream regression suites](uri-query-resolution-performance.md)
retain these measurements as the preceding snapshot.

This pass follows the [query refinements](uri-query-refinement.md). It retains
three small changes in `uri-query.ts`: named setters assign directly, named
additions bypass temporary entry objects, and single-value removal avoids wrapping
values in arrays and running nested `some` callbacks. Object overloads, regex
matching, scalar/array shape, prototype-key filtering and mutation behavior remain
covered by tests. There are no new dependencies or URI fields. The URI class source
and compiled runtime are byte-identical to the preceding version.

## Why the parsed-query cache was rejected

Chaining syntax itself is inexpensive; repeated work inside helpers is the target.
A prototype kept normalized parsed data in an ordinary optional property after
helper edits. Later helpers copied that data instead of parsing the query string.
Query strings were still rebuilt eagerly to preserve error timing and encoding-mode
semantics. Returned data remained independent, clones discarded the cache, and
replacement or space-mode changes invalidated it. No private fields or WeakMaps
were involved.

The prototype passed focused compatibility tests and a **24,000-step stateful
comparison** against the preceding wrapper, including flags, invalid encodings,
callbacks, clones, replacements and structured-clone restoration. An empty bare
query name required special care: it serializes as an empty entry and must not
appear in normalized cached data.

Node profiles showed the intended reduction: `parseQuery` fell from **20.38% to
6.95% of inclusive samples** in the representative three-helper chain. But copying
cached records and appending normalized values took about **9.93% of self samples**,
with further bookkeeping and allocation costs. These are profile shares, not
elapsed-time ratios.

The prototype's observed changes were -11.90% for a single addition, -14.96% for a
short chain, and -17.60% for a 24-key encoded query chain. **All controls failed.**
The simpler named-helper prototype also failed its control, with a -21.02% median
for the short chain. These separate measurements do not establish that either
prototype is faster than the other. The cache added state, invalidation rules and
memory use without a demonstrated advantage, so it was reverted. Its implementation,
profiles, correctness logs and all measurements remain in the task artifacts.

The retained implementation therefore continues to parse/build the query for each
helper call. Full URL serialization still uses the existing lazy cached string.
The existing `query(callback)` API remains available to group edits into one parse
and build; no new deferred-query mode was introduced.

## Final short paired measurements

The final campaign compares the retained helper changes with the immediately
preceding wrapper and URIjs 1.19.11, using direct APIs on Node 22.13.0. Negative
percentages mean less elapsed time. **Removing a query value passed its control**
and took **4.31% less time than the preceding wrapper** and **72.03% less than
URIjs**. Query-object writes, whose path is unchanged, passed the control but
showed no resolved before/after difference. The other five controls failed.

| Case | Time vs preceding wrapper | 95% interval vs preceding wrapper | Time vs URIjs | Control 95% interval | Result |
| --- | ---: | --- | ---: | --- | --- |
| Single addQuery | -16.34% | -26.39% to -10.24% | -71.08% | -5.08% to +2.91% | unresolved control |
| Remove one query value | -4.31% | -9.12% to -1.83% | -72.03% | -2.62% to +3.54% | faster |
| Add/set/remove chain | -19.10% | -24.98% to -6.54% | -73.89% | -5.29% to +3.50% | unresolved control |
| Chain on a 24-key encoded query | -5.08% | -16.99% to +3.54% | -50.77% | -3.77% to +6.06% | unresolved control |
| Three edits in query(callback) | -21.87% | -34.10% to -16.05% | -69.86% | -17.69% to +3.48% | unresolved control |
| Query-object write (unchanged path) | +0.22% | -2.36% to +21.81% | -83.95% | -3.93% to +0.47% | unresolved difference |
| Absolute parse (unchanged path) | +1.32% | -3.56% to +6.17% | -72.13% | -2.65% to +10.82% | unresolved control |

The apparent gains in additions, chains and callback batches remain inconclusive.
The absolute-parse row is an unchanged-path diagnostic; no parser improvement is
claimed. These results are not a whole-engine comparison or a universal speedup.
The callback and chained workloads run in separate cases, so their aggregate times
are not a controlled comparison of batching against chaining.

The fixed protocol retains four slots (URIjs, baseline, candidate, identical
candidate control), rotated/reversed order, two observations per slot, four
discarded calibration rounds and **16 measured rounds** per case. A case requires
at least 12 retained rounds. Exact preflight strings and timed checksums must match.
Integer CPU probes bracket every batch; a round is excluded above 1.5 times the
median calibration maximum or 250 ms wall time. Bounded 20 ms idle waits precede
measured rounds. The seeded 10,000-resample bootstrap control interval must contain
zero and stay entirely within ±5%; both candidate slots must agree on direction.
No final cases were retried and no thresholds relaxed.

All 16 rounds were retained for all seven cases. Whole-round medians were
**45–74 ms**. Slowest-batch sizing targets 12 ms; the 24-key workload uses smaller
sizing increments and warmups to keep it short. Windows CPU samples were
**55%, 43%, 49% during exploratory setup**, **12%, 8%, 8% before the final campaign**,
and **13%, 11%, 19% afterward**. Failed controls still limit the conclusions despite
the lower final host samples.

## Profiling and validation

Node's inspector CPU profiler sampled at a requested **100 µs interval** after
warmup for about 1.2 seconds per workload. The baseline, direct-helper prototype,
cache prototype and final build have separate profiles. Separate V8 `--prof` runs
at 100 µs and `--prof-process` reports record builtins and bottom-up caller stacks
for the baseline and final helper workload. Profilers were disabled during timing.
The retained changes remove temporary object/entry-array construction for string
names and redundant scalar matcher arrays. Query parsing, encoding and string
construction remain substantial costs.

Validation on the retained build passed:

- **588 tests / 46 suites**, lint, strict test types and build.
- **24,000 stateful chained operations** in 800 sequences against the baseline.
- **25,250 additional before/after comparisons** and **2,000 direct URIjs query comparisons**.
- Existing **6,000 canonical comparisons** and **192 native setter cases**.
- The compatibility matrix remains **116/118**, with the same two documented
  hostless-reference-to-HTTP differences.
- Packed consumer strict declarations and main/worker/logger smoke checks.
- Tested source, built files, frozen measured runtime and packed runtime bytes agree.

Validation uses an isolated snapshot excluding the unrelated `src/shared-context.ts`
draft. The consumer is an extracted tarball with the existing validated production
dependency tree. Windows runtime checks were not repeated. The initial test-annotation
correction and all unsuccessful controls remain in the logs.

[Full evidence](evidence/uri-query-helpers-performance.json) includes raw timing
observations, calibration and sizing data, host samples, profile summaries,
processed V8 reports, validation results and hashes. Raw profiles, immutable
prototypes, the exact benchmark drivers and logs are under
`/mnt/e/tmp/wse-uri-cache-20261005/`. The reusable
[short benchmark](../scripts/benchmark-uri-short.mjs) includes single-helper,
remove-value, long-chain and callback-batch cases. Prior reports and accepted engine
campaigns retain their recorded scope.
