# URI wrapper optimization target audit

The later [MDN artifact/log probe](mdn-uri-probe.md) expanded the workload,
found compatibility bugs, and identified additional path and hostname
normalization work. The stopping decision below applies to this earlier corpus.

This goal followed [query-write/base-resolution optimization and upstream test
hardening](uri-query-resolution-performance.md). The audit retained three changes
and found no further high-value or high-priority code target justified by the
current workload and profiles. This is a scoped engineering conclusion, not a
claim that the wrapper is globally optimal or that the performance gate passed.

## Retained changes

1. **Constructor base reuse.** Existing wrapper and native URL bases provide their
   serialized value directly; string bases go directly to native resolution.
   Parts objects still use the compatibility builder. A string-base construction
   creates one native URL object instead of constructing a wrapper/native URL
   for the base first and then another URL for resolution. Native URL inputs with
   a base no longer have their components loaded once before resolution and again
   afterward. Wrapper input flags and independent copies remain covered.
2. **Key-only query existence.** `hasQuery(string)` and `hasSearch(string)` scan
   delimiters and decode keys, returning on a match. They do not decode unrelated
   values or allocate a parsed query object and duplicate-value arrays. Both
   delimiters advance monotonically, including long runs of bare keys. Empty
   names, repeated question marks, malformed escapes, space modes and prototype
   filtering retain the preceding behavior. Other overloads keep full parsing.
3. **IP detection only where needed.** `is(relative)`, `is(absolute)`, `is(url)`,
   `is(urn)`, IDN/punycode and fixed predicates no longer run IP detection first.
   Domain/IP predicates still do. The engine calls `is(relative)` during link
   handling; the query-existence and two-argument constructor APIs are primarily
   public-wrapper opportunities, not demonstrated engine hot spots.

No new state, private fields, cached query records or dependencies were introduced.
The constructor and `absoluteTo` share a small base-serialization helper.

## Profiling and the stopping decision

Node's inspector requested 100 µs sampling after warmup, for about 1.2 seconds
per workload. Baseline profiles were exploratory diagnostics (some overlapped
initial focused validation); expanded profiles ran afterward. Neither is a paired
time measurement. The expanded runtime equals the final tested/measured/packed
runtime byte for byte.

- In the baseline key-existence profile, `parseQuery` accounted for **40.65%**
  of self samples, `decode` **33.70%**, and `decodeQuery` **11.71%**. Full parsing
  disappears from the final existence path; key scanning and decoding remain.
- Baseline relative-predicate samples included **41.18% in isIPv6** and
  **15.02% in isIPv4**. Those calls disappear from the final relative predicate;
  most final samples are then in the driver, with `is` at **0.33%** of self samples.
- Native parsing accounts for about **71%** of final constructor self samples.
  Avoidable base wrapping/parsing and redundant component extraction were removed;
  native URL validation and canonicalization remain substantial work.

Sample shares describe attribution and do not establish elapsed-time gains.

| Remaining idea | Decision and reason |
| --- | --- |
| Replace native parsing or introduce WASM | No demonstrated kernel justifies conversion and compatibility costs; native semantics are an explicit requirement. |
| More spelling-specific key-scanner branches | Lower priority: required decoding remains, while full parsing/allocation has already been removed. No demonstrated incremental benefit. |
| Optimize value/regex/callback query matching | Lower priority: duplicate/coercion/order/callback semantics add complexity, and no engine hot calls were found. |
| Reintroduce parsed-query caching or hostname rewrites | Prior experiments did not establish sufficient benefit; do not repeat them without new evidence. |
| Fuse credential/compound-authority setters | Possible future saving, but no hot call sites in the inspected engine paths make it a priority now. |
| Tune clones, getters and cached serialization further | Scalar copies and cached strings already avoid the major work; profiles do not identify a remaining dominant target. |

The next useful performance work is reliable validation on a quieter host or
profiling a concrete consumer workload that changes these priorities. Neither
justifies speculative code changes or repeated attempts to obtain a passing
control on this host. Existing accepted whole-engine campaigns remain untouched.

## Final short paired measurements

**All 11 identical-code controls failed. No new speedup or slowdown is established.**
The large negative medians below are observations, not accepted improvement claims.
The +12.50% resolution median is retained on the same basis. Negative values mean
less elapsed time; the baseline is the immediately preceding wrapper.

| Case | Time vs baseline | 95% interval | Time vs URIjs | Control 95% interval | Retained |
| --- | ---: | --- | ---: | --- | ---: |
| Constructor: wrapper base | -5.82% | -16.40% to +8.46% | -77.07% | -25.54% to +24.17% | 15/16 |
| Constructor: string base | -38.20% | -47.36% to -30.51% | -84.18% | -13.21% to +23.37% | 16/16 |
| Constructor: native URL base | -6.48% | -20.70% to -2.87% | -84.33% | -19.30% to +14.55% | 14/16 |
| Constructor: native URL input + wrapper base | -23.74% | -31.98% to -7.83% | -68.61% | -10.28% to +19.65% | 12/16 |
| Key existence: short query | -74.20% | -78.71% to -71.03% | -94.42% | -2.18% to +9.18% | 14/16 |
| Key existence: 24-key query | -91.83% | -93.14% to -90.49% | -97.10% | -2.58% to +24.41% | 16/16 |
| Key existence: encoded/malformed keys | -38.30% | -45.61% to -33.52% | -44.40% | -5.81% to +5.42% | 16/16 |
| Key + value matching (fallback) | -5.37% | -13.56% to +7.63% | -80.29% | -8.46% to +4.02% | 16/16 |
| is(relative) | -67.14% | -73.22% to -60.63% | -87.81% | -19.78% to +19.74% | 15/16 |
| Absolute parse (diagnostic) | -5.21% | -10.70% to +13.36% | -70.70% | -26.54% to +17.83% | 14/16 |
| absoluteTo wrapper base (diagnostic) | +12.50% | -1.13% to +40.44% | -70.50% | -22.51% to +5.87% | 16/16 |

Every case uses equivalent direct API calls on URIjs 1.19.11 and both wrapper
versions, with a fourth identical-candidate control. Key-existence workloads mix
early, later and missing keys. The encoded case includes malformed key escapes;
prototype-name differences are validated separately and are not timed as equivalent
outputs. Input preparation is outside timing; results are consumed within timing.

The protocol uses Node 22.13.0, rotated/reversed order, two observations per slot,
four calibration rounds and **16 fixed measured rounds**. The slowest-batch target
remains 12 ms. The 24-key existence case uses small sizing increments; the fast
predicate case permits up to 262,144 operations (it selected 25,856) so the target
is not prevented by the old cap. These settings were fixed before final timing.
Whole-round medians were **45–79 ms**. Every case retained at least 12 rounds;
**164/176** rounds remained overall.

Integer probes bracket each batch. A whole round is excluded above 1.5 times the
median calibration maximum probe or 250 ms wall time; bounded 20 ms waits precede
measured rounds. Preflight exact outputs and timed checksums must match. The seeded
10,000-resample bootstrap control interval must contain zero and stay entirely
inside ±5%; both candidate slots must agree on direction. No final cases were
retried and no thresholds were relaxed. Tests, profiles and consumer checks did
not run during the final timing campaign.

Host CPU samples were **46%, 46%, 48% before** and **47%, 50%, 40% after**. Filtering
and the short windows did not yield stable identical-code controls. Earlier
controlled results retain their own snapshots and scope; these observations are
not a new universal wrapper or engine-versus-0.9.1 comparison.

## Correctness and upstream regression coverage

- **706 tests / 47 suites**, strict test types, lint and build passed.
- New targeted comparisons matched the preceding wrapper for **60,322 query
  existence checks**, **10,710 constructor input/base combinations**, and
  **1,258 predicate checks** (including case variants and errors).
- The same 60,322 existence checks were compared with URIjs: **49,486 agreed**.
  The **10,836 existing differences** were exclusively inherited names:
  `__proto__` (10,486) and absent `constructor` (350). URIjs reports these inherited
  properties as present; the wrapper continues to require actual parsed keys.
  All raw differences are retained, with no new before/after differences.
- **24,000 stateful operations**, **25,250 additional before/after checks**,
  **2,000 URIjs query comparisons**, **6,000 canonical comparisons** and
  **192 native setter comparisons** passed.
- The permanent upstream-derived suites retain **182 assertions** and **48
  resolution vectors in two base forms**, with explicit native differences.
  The original non-browser upstream audit is unchanged: URIjs 143/143, each
  wrapper 45/143. Internal `_parts` checks and unsupported semantics make this
  a diagnostic function count, not a semantic coverage percentage.
- The selected extension matrix remains **116/118**, with its two prior differences.
- Packed consumer strict declarations and main/worker/logger smoke checks passed.
- Repository source, tested snapshot, frozen measured runtime and packed runtime
  bytes agree. Validation excludes the unrelated `src/shared-context.ts` draft;
  production dependencies are reused from the validated consumer tree. Windows
  runtime checks were not repeated.

[Full evidence](evidence/uri-optimization-target-audit.json) includes every timing
observation, profile summary, host sample, the target-priority audit, validation
results and hashes. Complete differential differences, original upstream audit,
raw CPU profiles, immutable variants and logs are under
`/mnt/e/tmp/wse-uri-target-audit-20261005/`. No changes were committed or pushed.
