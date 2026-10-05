# Expanded URI wrapper: compatibility and direct-call performance

For the subsequent profiling and optimization pass, see
[short paired measurements and detailed Node profiles](uri-profile-optimization.md).
The measurements below retain the original expanded-wrapper snapshot.

The expanded wrapper stores components in ordinary string fields and uses
native URL temporarily for absolute parsing and exceptional validation. It
exposes all 58 URIjs 1.19.11 core instance method names: 57 have best-effort
implementations, and `iso8859()` explicitly rejects unsupported Latin-1 mode.
The [migration guide](native-url-migration.md) lists overloads, static utilities
and partial behavior; method-name coverage is not semantic equivalence.

## Performance versus URIjs

Five of 13 cases passed the identical-code control and agreed across both
candidate copies. Compared with URIjs, elapsed time was approximately:

- **70% lower** for absolute parsing and serialization.
- **17% lower** for eight component getters.
- **80% lower** for changing path/query/hash mutations.
- **87% lower** for relative resolution.
- **22% lower** for add/set/remove query helpers.

The other eight controls failed, so their apparent gains remain inconclusive.
All comparisons here are direct URIjs-style API calls on Node 22.13.0; no engine,
DOM, worker, network or filesystem work is inside the measured batches.

| Case | Paired time change vs URIjs | 95% interval | Change vs prior wrapper | Result |
| --- | ---: | --- | ---: | --- |
| Absolute parse + serialize | -70.16% | -71.26% to -69.40% | +42.80% | faster |
| Relative parse + serialize | -80.40% | -81.20% to -78.18% | -14.45% | unresolved-control |
| Eight component getters | -16.55% | -21.00% to -14.35% | -10.63% | faster |
| Clone + serialize | -94.43% | -94.74% to -93.66% | -91.48% | unresolved-control |
| Path/query/hash: repeated values | -94.38% | -94.58% to -93.96% | -91.22% | unresolved-control |
| Authority: repeated values | -79.04% | -79.67% to -78.11% | -94.75% | unresolved-control |
| Path/query/hash: changing values | -80.20% | -81.78% to -79.84% | -72.69% | faster |
| Authority: changing values | -35.10% | -36.83% to -30.45% | -82.72% | unresolved-control |
| absoluteTo + serialize | -80.30% | -80.87% to -78.75% | -28.28% | unresolved-control |
| relativeTo + serialize | -87.18% | -87.52% to -86.83% | -43.54% | faster |
| Parsed-query read | -35.27% | -37.08% to -31.29% | +60.83% | unresolved-control |
| Query-object write | -41.11% | -42.95% to -37.97% | +42.03% | unresolved-control |
| Add/set/remove query helpers | -21.65% | -23.88% to -19.48% | Unavailable | faster |

Negative percentages mean less elapsed time. They are medians of paired ratios,
not ratios of aggregate medians. `unresolved-control` applies to both comparison
columns. The full evidence includes the second candidate copy, control intervals
and every warmup, calibration and measured observation.

There is a real tradeoff against the earlier, smaller symbol wrapper:
**absolute parsing is about 43% slower**, although still 70% faster than URIjs.
Getters, changing path/query/hash mutations, and relative resolution improved
against that wrapper with passing controls. Query reads/writes also showed
higher medians than the prior wrapper, but their controls failed. The prior
wrapper did not implement the query-helper case.

## Profiling and implementation choices

In the old authority-mutation profile, native `update` and `parse` frames accounted
for about **57% of self samples**, with additional URL construction and native
setter work. The new common HTTP(S)/FTP authority path validates and updates
component strings directly. Those native update/parse frames disappear from the
corresponding profile; its leading costs are hostname validation, protocol/port
handling and the driver loop. The changing-authority timing median improved
about 35% versus URIjs and 83% versus the old wrapper, but the failed control
prevents treating these percentages as confirmed gains.

Cloning copies scalar state; relative resolution reuses an existing base
wrapper; unchanged setter values avoid invalidating cached serialization.
Absolute parsing pays the cost of extracting component strings once, making
subsequent reads independent of native URL getters. The benefit comes from
avoiding repeated parsing and setter work, not a demonstrated property-name
or private-field syntax effect.

A follow-up parse profile still showed native parsing as the leading cost. Two
local experiments tried splitting canonical native serialization and removing
duplicate field initialization. Neither provided convincing profile evidence
for adoption; both remain untracked experiments. Profiling durations are
diagnostic and are not paired performance measurements. The final source and
all reported paired results use the retained, tested implementation.

## Fixed protocol and noise

Each common case compared URIjs, the prior symbol wrapper, the new wrapper,
and an identical new-wrapper control. Query helpers used three variants because
the old wrapper lacks those APIs. Each case ran in its own process with two
warmups per variant, four discarded calibration rounds and 16 measured rounds.
Each round contained two observations per variant, with rotating starting
positions and reversed order.

Batches contain 20,000–200,000 operations according to the frozen case. They
are larger than the initial campaign to reduce short-batch noise. The initial
campaign repeatedly assigned identical values to each pooled object; this
campaign preserves those cases and adds mutations whose values actually change.
Query-object timing uses distinct values so all four implementations produce
the same output; duplicate/bare-key compatibility is checked separately.

Forced GC, input preparation and instance pools are outside timing. Results
are consumed inside timing; preflight compares exact strings over 256 calls
and timed batches check output checksums. CPU probes bracket each observation.
A whole round is excluded above 1.5 times the median calibration maximum.
At least 12 retained rounds are required; intervals use 10,000 seeded bootstrap
resamples. Controls must include zero and stay inside ±5%, and both candidate
copies must agree on the direction.

All 16 rounds were retained for every case. Host CPU before measurement was
**24%, 21%, 19%**, with no quiet-host claim. Eight controls still failed. No
rounds were added, thresholds changed, or failed cases rerun to obtain a pass.
No universal non-regression or whole-crawler performance claim follows.

## Validation and artifacts

- **571 tests / 46 suites**, strict test types, lint and build passed.
- Packed consumer strict declarations and all 13 runtime harnesses passed;
  the final packed bytes also passed main/worker and optional-logger checks.
- Native Windows passed all 14 runtime harnesses on the final installed package.
- The existing canonical differential corpus matched **6,000 cases**.
- The extension matrix matched **116 of 118 cases**. Its two differences are
  documented native reparsing of hostless relative/file references changed to
  HTTP, instead of URIjs malformed `http:///...` spelling.
- All **192 native setter cases** matched; the migrated MDN consumer type-checks.
- Installed compiled bytes, tested source and frozen benchmark inputs match.

An initial Windows check could not follow the Linux dependency symlink; copying
the unchanged dependency tree into the validation directory resolved it. A
tarball refresh pruned the optional log4js peer; reinstalling it restored the
with-peer check. These setup failures and initial compatibility failures remain
in the artifact logs. They are not discarded performance samples.

[Full evidence](evidence/uri-extended-validation.json) contains raw paired data,
profiles summaries, validation results and hashes. Frozen sources, profiling
drivers, experiments, logs, consumers and runners are under
`/mnt/e/tmp/wse-uri-extended-20261005/`. The reusable direct-call harness is
[scripts/benchmark-uri.mjs](../scripts/benchmark-uri.mjs). Earlier accepted engine
campaigns and earlier direct-call evidence remain unchanged.
