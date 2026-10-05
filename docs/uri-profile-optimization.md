# Further URI wrapper optimization with Node profiling

The subsequent [query refinements and hostname experiments](uri-query-refinement.md)
evaluate the four follow-up suggestions. This report retains its original snapshot.

This pass optimizes the expanded ordinary-string-field wrapper from
[the extension report](uri-extended-performance.md). It does not change the
URIjs API surface or documented compatibility limits. No dependencies were added.

The implementation avoids unnecessary work in query encoding/decoding and
serialization, component extraction, and authority setters. All 577 tests pass.
**The final short campaign failed all eight identical-code controls**, so its
observed timing improvements are diagnostic, not a final performance gate.
An earlier exploratory query-write comparison passed its control and measured
58.58% less time than the preceding wrapper (95% interval -59.59% to -56.75%) and
75.52% less than URIjs. That earlier result is kept separate from the final run.

## Changes and profiling evidence

Node 22.13.0's built-in inspector CPU profiler sampled at a requested **100 µs**
interval after 100,000 warmup operations, for about **1.2 seconds per workload**.
The saved `.cpuprofile` files contain full call trees and sample timestamps;
JSON summaries include self and inclusive sample shares. Separate V8 runs used
`--prof --prof-sampling-interval=100`, with `--prof-process` reports for JavaScript,
builtins, GC, native/shared-library attribution and bottom-up caller stacks.
The two profilers were disabled during every paired timing measurement.

| Profile location | Before: sample share | After: sample share | Change |
| --- | ---: | ---: | --- |
| Query write: encoding, inclusive | 51.77% | 24.31% | Return unreserved strings directly; avoid unnecessary space replacement |
| Query read: decoding, inclusive | 36.10% | 13.38% | Decode only percent escapes; replace plus only when present |
| Query helpers: query building, inclusive | 49.52% | 27.75% | Avoid entry pairs, scalar arrays/Sets and the output array/join |
| Bare absolute parse: component loading, inclusive | 23.63% | 9.13% | Reuse native getters; inspect empty query delimiter without split allocation |
| Changing authority: port setter, inclusive | 12.01% | 0.77% | Validate numeric ports directly; avoid regex replacement and redundant conversion |

These percentages describe **where the samples went**, not elapsed-time ratios
or isolated causal estimates. Inlining and GC affect attribution. The V8 write
profile corroborates the removed `ObjectEntries`, array join/push and replacement
work; its remaining costs include string construction, the unreserved-character
check and Sets for deduplicating arrays. Sets remain for array inputs to preserve
linear-time duplicate handling. Malformed escapes, Unicode, bare keys, undefined
values, duplicate flags and space-encoding flags retain supported behavior.

Hostname checks combine the numeric/punycode fallback predicates. Protocol and
port setters use direct delimiter checks. Native parsing remains responsible
for URL validation and canonicalization: its parser frame still accounts for
about 49% of absolute-parse samples. This pass does not establish that the prior
parsing regression against the older, smaller symbol wrapper has disappeared.

## Final short paired measurements

Negative changes mean less elapsed time. “Before” is the preceding **expanded**
wrapper, frozen before this pass; it is not 0.9.1 or the earlier symbol wrapper.
**Every row below is unresolved because its identical-code control failed.**
The apparent direction alone is insufficient for a validated speedup claim.

| Case | Time vs before | 95% interval vs before | Time vs URIjs | Control 95% interval | Retained rounds |
| --- | ---: | --- | ---: | --- | ---: |
| Absolute parse + serialize | -3.35% | -10.53% to +0.86% | -72.28% | -3.89% to +10.53% | 15/16 |
| Parse without query/fragment | -19.08% | -27.32% to -6.67% | -73.35% | -21.83% to +22.55% | 15/16 |
| Parsed-query read | -25.31% | -30.99% to -9.41% | -52.63% | -7.62% to +5.70% | 16/16 |
| Query-object write | -55.78% | -64.82% to -54.54% | -73.77% | +0.48% to +8.56% | 15/16 |
| Encoded/Unicode query write | -2.04% | -15.73% to +8.73% | -31.15% | -14.78% to +10.34% | 16/16 |
| Query array: 64 entries, 32 unique | -61.07% | -66.85% to -56.59% | -77.84% | -16.37% to +10.83% | 14/16 |
| Add/set/remove query helpers | -59.70% | -62.60% to -52.83% | -65.53% | -4.84% to +25.62% | 16/16 |
| Changing protocol/hostname/port | -13.72% | -18.37% to -5.69% | -47.75% | -5.84% to +0.53% | 16/16 |

The final campaign uses four slots: URIjs 1.19.11, the frozen preceding wrapper,
the candidate, and the same candidate in an independent slot. It rotates and
reverses order; every round contains two observations per slot. Each case runs
in a separate process, with 32,768 warmup operations per slot and discarded
sizing/calibration observations. All variants use the same operation count,
chosen to target 12 ms for the slowest batch, bounded to 512–16,384 operations.

There are four calibration rounds and **16 fixed measured rounds** per case.
Whole-round medians range from **58 to 93 ms**; the longest observed round was
143 ms. Operation counts are 512–8,064, and case-level median batches range from
3.8 to 9.3 ms. Short rounds help fit brief idle windows, but give small effects
and fast variants less timing resolution than longer runs.

A 250,000-operation integer probe brackets each batch. Before each measured
round, up to ten 20 ms waits seek a probe within 1.2 times the median calibration
maximum; all rounds happened to pass this preliminary check on the first try.
The whole round is excluded if a bracketing probe exceeds 1.5 times the median
calibration maximum, or its wall time exceeds 250 ms. Five of 128 rounds were
excluded. Every case retained at least 14 rounds; the required minimum was 12.
Preflight compares exact strings over 512 calls; timed output is consumed and
checksums must agree. GC is forced once before each complete round, outside timing.

The control requires a seeded 10,000-resample bootstrap 95% interval containing
zero and entirely inside ±5%. Both candidate slots must agree on direction for
a comparison to pass. These rules were frozen before the final campaign and
were not relaxed; there were no final-case retries or extra rounds.

Windows host CPU samples were **36%, 22%, 30% before**, and **29%, 60%, 42% after**.
Earlier setup samples ranged from 16% to 92%. Neither load averages nor quick CPU
probes caught all interference; the failed controls are evidence of that limit.
The earlier exploratory write check used the same short-batch approach, before
the authority changes and final idle-probe addition; exploratory parsing and
authority controls failed. All exploratory data and protocol versions are retained.

## Validation and reproduction

- **577 tests / 46 suites**, lint, strict test types and build passed.
- **25,250 before/after differential checks**, plus **2,000 direct URIjs query checks**, passed.
- Existing **6,000 canonical comparisons** and **192 native setter comparisons** passed.
- The extended compatibility matrix remains **116/118**, with only the two
  previously documented hostless-reference-to-HTTP differences.
- Packed consumer declarations and main/worker/logger runtime smoke checks passed.
- Tested source, built files, frozen measured runtime and packed runtime bytes match.

Validation used an isolated repository snapshot to preserve the unrelated
`src/shared-context.ts` draft. The tarball was extracted into a separate consumer
with links to existing production dependencies. Its first check picked up the
build snapshot's placeholder `undici`; using the existing validated production
dependency tree resolved that setup failure. Initial compile/lint corrections,
the failed consumer setup and the first combined-profiler diagnostic are retained
in logs. Windows checks from the prior pass were not repeated or claimed here.

The reusable tools are [the short benchmark](../scripts/benchmark-uri-short.mjs)
and [the Node profiler](../scripts/profile-uri.mjs). Example commands, after
configuring task-local temporary/cache directories as required by `AGENTS.md`:

```sh
node --expose-gc scripts/profile-uri.mjs AFTER_URI_JS write OUTPUT_PREFIX
node --prof --prof-sampling-interval=100 --no-logfile-per-isolate \
  --logfile=TASK_DIR/ticks.log --expose-gc scripts/profile-uri.mjs \
  AFTER_URI_JS write OUTPUT_PREFIX --ticks
node --prof-process TASK_DIR/ticks.log > TASK_DIR/ticks.txt
node --expose-gc scripts/benchmark-uri-short.mjs \
  URIJS_ENTRY BEFORE_URI_JS AFTER_URI_JS query-write OUTPUT_JSON
```

The full [evidence file](evidence/uri-profile-optimization.json) contains every
final and exploratory timing observation, profile summaries, processed V8 reports,
host samples, validation results and artifact hashes. Raw `.cpuprofile` files,
V8 logs, immutable runtime copies, exact drivers and validation logs are under
`/mnt/e/tmp/wse-uri-profile-20261005/`. The API compatibility guide and older
accepted engine/direct-call reports remain applicable within their recorded scope.
