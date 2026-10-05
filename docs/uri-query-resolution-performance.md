# Query writes, base reuse, and upstream URIjs regression suites

The subsequent [optimization target audit](uri-optimization-target-audit.md)
covers constructor bases, query existence and URI predicates. These measurements
remain the preceding snapshot.

This pass follows [named query helper optimization](uri-query-helpers-performance.md).
Two small changes are retained in `src/uri.ts`:

- Object-query setters install the output of `buildQuery` directly. Its encoded
  output does not need the general `search` setter's unsafe-character scan.
  Empty delimiters, unchanged values, eager encoding errors and full-URL cache
  invalidation preserve the preceding behavior. Raw string setters keep their
  existing validation.
- `absoluteTo` reads an existing wrapper base's serialization directly instead
  of copying the wrapper first. String, native URL and parts-object bases retain
  their supported behavior; resolution still uses native URL parsing.

There are no new fields, private fields, cached query objects or dependencies.
`src/uri-query.ts` is unchanged. The source, tested build, frozen measured runtime
and packed consumer bytes were checked for agreement.

## Fixed short measurements

**All seven identical-code controls failed. This campaign establishes no new
speedup or slowdown.** The changes remain small reductions in redundant work;
these results are not a performance acceptance gate. Negative numbers mean less
elapsed time. The baseline is the immediately preceding wrapper, not engine 0.9.1.

| Case | Time vs baseline or chain | 95% interval | Time vs URIjs | Control 95% interval | Retained |
| --- | ---: | --- | ---: | --- | ---: |
| Query-object write | +7.98% | -3.22% to +10.49% | -84.28% | -11.16% to +39.98% | 16/16 |
| Encoded/Unicode query write | -1.91% | -9.57% to +5.22% | -31.51% | -19.43% to +14.15% | 14/16 |
| Add/set/remove chain | -14.97% | -26.70% to -6.94% | -79.33% | -7.87% to +9.99% | 16/16 |
| 24-key encoded query chain | +1.60% | -9.12% to +8.31% | -53.03% | -5.98% to +11.14% | 13/16 |
| absoluteTo: wrapper base | -14.64% | -27.03% to +5.51% | -75.21% | -5.17% to +14.96% | 12/16 |
| absoluteTo: string base | +1.22% | -5.24% to +23.44% | -81.39% | -19.35% to -5.99% | 16/16 |
| Callback batch versus final wrapper chain | -62.82% | -69.36% to -55.31% | -91.53% | -13.50% to +11.31% | 16/16 |

For the last row only, slots are URIjs chain, final-wrapper chain, final-wrapper
callback batch, and an identical final-wrapper batch control. Its -62.82% median
is a **direct paired batching comparison**, but the failed control still makes it
inconclusive. Its URIjs column compares a wrapper batch with a URIjs chain and
must not be described as a same-API implementation speedup. All other rows use
the same API workload for URIjs, baseline, candidate and candidate control.
The +7.98% query-write median and +1.60% long-chain median are retained; neither
establishes a regression. The string-base case is a diagnostic for the branch
that still resolves from a string.

The protocol remains fixed: Node 22.13.0, URIjs 1.19.11, four slots in rotated
and reversed order, two observations per slot, four calibration rounds and 16
measured rounds. The slowest-batch target is 12 ms; whole-round medians were
47–77 ms. Preflight exact strings and timed checksums must agree. Integer CPU
probes bracket each batch; whole rounds are excluded above 1.5 times the median
calibration maximum probe or 250 ms wall time. Bounded 20 ms waits precede measured
rounds. At least 12 rounds must remain. The seeded 10,000-resample bootstrap
control interval must include zero and lie entirely inside ±5%. Both candidate
slots must agree on direction. No cases were retried or thresholds relaxed.

Host CPU samples were **39%, 44%, 86% before** and **49%, 57%, 36% after**.
The final cases retained 12–16 rounds. Filtering did not remove enough interference
to obtain stable controls. Profiling, tests and consumer checks were outside the
measurement campaign. Earlier accepted results retain their original scope;
there is no new whole-engine or engine-0.9.1 comparison here.

## Profiling findings

Separate Node inspector profiles requested 100 µs sampling after warmup, for
about 1.2 seconds per workload, on the baseline and final runtime. In the helper
profile, `search` self samples fell from **16.07% to 5.83%**; it still runs for the
raw query reset in the driver. Query parsing and building remain substantial.
In resolution profiles, `absoluteTo` self samples fell from **7.50% to 4.80%**,
while native parsing accounted for **66.64%** of final self samples. These are
sample shares, not elapsed-time gains or isolated causal speed estimates.

Batching can eliminate repeated parse/build cycles, but intermediate normalization
is observable. Both URIjs and this wrapper produce `x=new` for
`setQuery('x', [null, 'null']).addQuery('x', 'new')`, and `x&x=new` when those static
helpers run in a single callback. The benchmark uses equivalent inputs, and a
regression test preserves both forms. No general automatic chain-to-batch rewrite
was introduced.

## Upstream test hardening

Pinned upstream source was downloaded from the URIjs **v1.19.11** tag. The new
[fixtures](../test/fixtures/urijs/README.md) require no runtime test dependency
or network access:

- **16 upstream callbacks / 182 assertions**, covering the complete query-mutation
  group, basic query setters, normalization, static setQuery, malformed charset,
  space encoding/decoding, injection, and 24 RFC 3986 resolution cases.
- Only four assertions inspecting URIjs's internal `_parts` duplicate-mode field
  were omitted; their exact text remains in metadata. All surrounding public
  duplicate-mode and clone behavior assertions execute, and every callback must
  execute its original public assertion count.
- All **48 original resolution table entries** run with both string and wrapper
  bases. Their original expected results and two exception markers remain intact.
  **19 entries agree with upstream**, and **29 carry explicit pre-existing native
  differences**: 11 rejected relative bases, 11 retained relative references and
  7 retained absolute references when authority/credentials differ.
- All selected callbacks and original vector expectations were first verified
  against URIjs itself. Source locations, hashes and the MIT license accompany
  the fixtures.

A broader diagnostic also executed the original non-browser test callbacks:
URIjs passed **143/143**; both the preceding and final wrapper passed **45/143**,
with exactly identical assertion outcomes and exceptions. This is **not a semantic
coverage percentage**: many callbacks access `_parts` and stop before their public
checks, while other failures expose documented or previously unenumerated API
limits. The complete raw results are retained. This pass does not claim full
upstream-suite conformance; the older 116/118 extension matrix is a different,
selected corpus. Browser-location and optional-library cases were excluded explicitly.

## Validation

- **703 tests / 47 suites**, lint, strict test types and build passed.
- **24,000 stateful operations**, **25,250 additional before/after comparisons**,
  **2,000 direct URIjs query comparisons**, **6,000 canonical comparisons** and
  **192 native setter cases** passed.
- The prior extension matrix remains **116/118**, with its same two differences.
- Packed consumer strict declarations and main/worker/logger smoke checks passed.
- The validation snapshot excludes the unrelated `src/shared-context.ts` draft.
  Consumer dependencies reuse the existing validated production tree. Windows
  runtime checks were not repeated.

Initial test-harness corrections (native errors crossing Jest realms, the batching
example, and a browser-only raw audit case) remain in the logs. They did not require
production-code changes. No timing samples were removed to improve a result.

[Full evidence](evidence/uri-query-resolution-performance.json) contains all seven
raw timing records, profile summaries, host samples, the complete upstream audit,
validation results and file hashes. Exact drivers, downloaded upstream sources,
CPU profiles, snapshots and logs are in `/mnt/e/tmp/wse-uri-final-paths-20261005/`.
