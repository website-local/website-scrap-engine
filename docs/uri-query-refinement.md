# Query refinements and hostname experiments

The next pass covers [query helper optimization and the parsed-cache experiment](uri-query-helpers-performance.md).
This report retains its original snapshot and measurements.

All four suggestions following the [first profiling pass](uri-profile-optimization.md)
were evaluated. Three query optimizations are retained. Both hostname alternatives
were rejected; the hostname source and compiled URI class are byte-identical to
the preceding version. State remains ordinary string fields, with no new retained
query objects, private fields or dependencies.

## Retained changes

1. **Scan query delimiters without splitting an array.** Both `&` and `=` searches
   advance monotonically. Runs of bare keys do not repeatedly search the remaining
   suffix for an absent equals sign. The parser preserves leading question-mark
   handling, empty names/values, embedded equals signs, duplicates, malformed
   escapes, prototype-key filtering and independent parsed results.
2. **Avoid Sets for arrays of at most two values.** A single prior string value
   handles deduplication. Larger arrays retain a Set, and duplicate-preserving mode
   allocates none. String-equivalent values, bare nulls and sparse/undefined entries
   retain the preceding behavior.
3. **Return unreserved query strings immediately.** `encodeQuery` avoids the
   second scan for `%20` when no encoding is required. The escaped path shares an
   encoding helper and checks the original string for literal spaces; literal
   percent sequences, plus signs, Unicode, invalid surrogates and both space modes
   remain covered by tests.

## Independent experiments and rejected hostname changes

Each prototype starts from the same frozen baseline and changes one proposed
optimization. The isolated encoding change passed the short benchmark's control:
query writes took **20.77% less time** than that baseline, with a 95% interval of
-26.20% to -14.60%, and 81.58% less than URIjs. Its control interval was -4.04% to
+1.58%. The scanner's apparent 21.82% improvement and small-array prototype's
11.26% improvement failed controls; they remain diagnostic observations.

Two hostname prototypes tried one combined validation expression: first with a
whole-name punycode rejection, then with checks at label boundaries. Their observed
time changes were **+10.67%** and **+0.39%**, respectively. Both controls failed;
neither established a benefit. The existing validator was restored. Fewer regular
expression calls did not supply enough evidence to justify changing this path.

The first hostname prototype also passed 52,649 predicate comparisons and 22,947
mutation comparisons; an additional 20,028 query cases covered delimiter combinations,
sparse arrays and larger arrays. These checks describe the exploratory prototype,
not a newly adopted hostname implementation. The final retained build separately
passed the validation listed below. All prototypes and their results are retained.

## Final short paired measurements

The final build compares the **three retained query changes together** with the
immediately preceding optimized wrapper and URIjs 1.19.11. Negative percentages
mean less elapsed time. One of six cases passed its identical-code control:
**encoded/Unicode query writes improved by 2.73% versus the baseline and 32.46%
versus URIjs**. The other five remain inconclusive despite mostly lower medians.

| Case | Time vs preceding wrapper | 95% interval vs preceding wrapper | Time vs URIjs | Control 95% interval | Result |
| --- | ---: | --- | ---: | --- | --- |
| Parsed-query read | -22.53% | -29.05% to -18.08% | -63.05% | -2.326% to +5.001% | unresolved control |
| Query-object write | -31.74% | -32.81% to -27.93% | -83.84% | -6.116% to +7.906% | unresolved control |
| Encoded/Unicode query write | -2.73% | -4.80% to -1.32% | -32.46% | -3.425% to +2.565% | faster |
| 64-value query array, 32 unique | -14.37% | -17.87% to -11.91% | -80.96% | +0.018% to +6.923% | unresolved control |
| Add/set/remove query helpers | -19.80% | -28.67% to -7.16% | -68.78% | -11.601% to +3.637% | unresolved control |
| 512 bare keys plus one valued key | -0.66% | -4.80% to +3.75% | -58.35% | -2.419% to +5.830% | unresolved control |

The parsed-query read control narrowly failed: its upper endpoint is **5.000951%**,
above the fixed 5% bound. It was not rounded into a pass. The large bare-key case
is effectively flat in this sample; the parser change does not establish a speedup
for every query shape.

The existing short protocol is preserved: four slots (URIjs, baseline, candidate,
and an identical candidate control), rotated and reversed ordering, two observations
per slot per round, four discarded calibration rounds and **16 fixed measured
rounds**. Exact preflight strings and batch checksums must match. A whole round is
excluded above 1.5 times the median calibration maximum CPU probe or 250 ms wall
time. The control's seeded 10,000-resample bootstrap interval must contain zero
and remain inside ±5%; both candidate slots must agree on direction. No cases
were retried and no thresholds changed after the final campaign began.

All 16 rounds were retained for each case. Whole-round medians were **49–87 ms**.
The 512-key case uses 16-operation sizing increments and a smaller warmup to keep
its batches short; ordinary cases retain 128-operation increments. The slowest
batch target remains 12 ms. Integer probes bracket each batch, and bounded 20 ms
idle waits precede each measured round. Every round passed the preliminary idle
probe on its first attempt, demonstrating that these probes do not catch all host
interference. Host samples and exact timings are in the evidence file.

## Node profiling

The retained build and frozen baseline were profiled separately with Node 22.13.0's
built-in inspector CPU profiler, using a requested **100 µs sampling interval**
after warmup for about 1.2 seconds per workload. Additional, separate V8 `--prof`
runs at 100 µs produced `--prof-process` reports with builtins and bottom-up caller
stacks. No profiler was enabled during paired timing.

| Inclusive sample share | Before | Retained build |
| --- | ---: | ---: |
| Query read: `parseQuery` | 42.12% | 30.58% |
| Query helpers: `parseQuery` | 27.56% | 18.55% |
| Query write: `buildQuery` | 60.85% | 50.46% |

The V8 query-write profile no longer attributes samples to `SetConstructor`,
`SetPrototypeAdd`, `FindOrderedHashSetEntry` or `StringIndexOf` in its JavaScript
flat list for the representative two-value workload. Larger query arrays still
use Sets. Remaining costs include string concatenation, character validation,
object-key access and JSON serialization in the read driver. Sample shares are
profiling diagnostics, not elapsed-time ratios or separate causal speed estimates.

## Validation and artifacts

- **581 tests / 46 suites**, lint, strict test types and build passed.
- **25,250 final before/after comparisons** and **2,000 direct URIjs query comparisons** passed.
- Existing **6,000 canonical comparisons** and **192 native setter cases** passed.
- The compatibility matrix remains **116/118**, with the same two documented
  hostless-reference-to-HTTP differences.
- Packed consumer strict declarations and main/worker/logger smoke checks passed.
- Tested source, final build, frozen measured runtime and packed runtime bytes match.
- The URI class source and compiled runtime match the pre-task baseline exactly.

Tests/build used an isolated snapshot excluding the unrelated `src/shared-context.ts`
draft. An initial byte check detected that a snapshot-only hostname revert had
been overwritten by source synchronization; the repository source was corrected
and the full suite/build repeated before final profiling and measurement. Both
runs and the correction are retained in logs. Consumer dependencies reuse the
previously validated production tree. Windows checks were not repeated in this pass.

The [full evidence](evidence/uri-query-refinement.json) contains every measured,
calibration, sizing and warmup observation, exploratory results, host samples,
profile summaries, processed V8 reports, validation results and hashes. Raw profiles,
immutable prototypes and exact drivers live under
`/mnt/e/tmp/wse-uri-four-20261005/`. The reusable
[short harness](../scripts/benchmark-uri-short.mjs) now includes `query-bare-read`;
[the profiler](../scripts/profile-uri.mjs) remains available for independent runs.
Previous reports and accepted engine campaigns retain their original scope.
