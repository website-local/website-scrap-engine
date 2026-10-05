# URI wrapper merge-readiness audit — 2026-10-05

The candidate is ready for review, with no known unaddressed correctness defect
from this audit. It is not an unconditional performance-gate pass: the MDN replay
remains noise-limited, and the full clean-install CI matrix still needs to run.
This report covers checkpoint `634e2d2` plus the four fixes below. Remote CI on
the prepared branch remains pending.

## Correctness changes

| Trigger | Defect before this audit | Corrected behavior |
| --- | --- | --- |
| Assign `https` to a scheme-relative URL | Fast path skipped native hostname validation/canonicalization | Uppercase, numeric and Unicode hosts canonicalize; invalid hosts throw without mutation |
| Mutate a hostless hierarchical `custom:/` path | Relative-looking paths could become opaque; leading `//` could become an authority after rebuilding | Native pathname setter and protective `/.` serialization preserve structure and native query/hash behavior |
| Normalize `./a:b`, `dir/../a:b`, or `a%3Ab` | Output `a:b` introduced a scheme when resolved | Preserve `./a:b` as a relative reference |
| Normalize `#:~:text=foo%2D,bar` | Decoding an unreserved hyphen changed text-fragment grammar | Preserve text directives and encoded directive markers verbatim |

The last issue came from investigating the remaining MDN normalization
differences. The MDN text-fragment page explicitly requires encoding hyphens
inside text parameters; ordinary URL-unreserved decoding is unsafe there.
Ordinary anchor normalization remains supported. Regression tests cover rebuilt
serialization, independent clones, resolution and failure without mutation.

The repeated corpus uses the previously corrected extraction inputs: 180,171
artifact input/base cases and 295,897 cases from all 42 package logs. It performs
**11,851,658 comparisons**, including **476,068 native raw-construction checks
with zero mismatches**. The artifact results are unchanged. For resolved log URLs,
`normalize()` differences against URIjs fall from five to zero;
`normalizeFragment()` differences fall from eight to three, all existing empty
delimiter differences. No comparison category gains failures.

These counts do not imply complete URIjs equivalence. Native parsing, empty
delimiters, opaque URL behavior and documented display/recoding differences
remain. Three existing two-stage `absoluteTo()` differences concern malformed
HTTPS inputs; direct two-argument construction follows native URL behavior.
The separate 225-case native mutation probe has zero failures or inconsistent
protocol transitions. See [compatibility limits](native-url-migration.md#best-effort-limits)
and the [original corpus report](uri-investigation-history.md).

## Validation of the actual package

| Check | Result |
| --- | --- |
| Node 22.13.0 Linux build, lint, strict test types and full Jest suite | Pass: 993 tests / 48 suites |
| Node 24.21.0 and 26.10.0 Linux wrapper, MDN and upstream regression suites | Pass on each: 407 tests / 3 suites |
| Fresh tarball, strict installed declarations and Linux runtime checks | Pass: 13 checks each on Node 22.13.0 and 26.10.0 |
| Same tarball, strict installed declarations and native Windows runtime checks | Pass: 14 checks each on Node 22.13.0 and 24.21.0 |
| Source/test snapshot integrity and whitespace | Pass |

The package is built from an isolated snapshot excluding the unrelated untracked
`src/shared-context.ts`. Installed checks use extracted tarball contents and
existing production dependency trees, including real Undici declarations and
the optional logging peer. No dependency was added. Package SHA-256:
`01bf322c84392ab06172f35de1b8df923897ba536beae1b5237ca50ca0b6dfb1`.

The initial audit reused dependency trees. Subsequent CI preparation passed a
fresh `npm ci`, build and all 993 tests on Node 22.13.0, with runtime/test source
bytes matching the audited snapshot. Linux Node 24's
verified binary fails direct execution on this host; focused tests passed via
the ELF loader, and full packed-consumer checks passed on native Windows Node
24. Full Jest on every runtime and the latest Node 22 release remain CI work.
The workflow matrix is 22.13.0, 22.x, 24.x and 26.x.

## Focused performance versus master

Baseline is exact local master `1dd221492221db5ceffaf9be4288f94e0c16a0ee`,
using URIjs. Candidate is the corrected snapshot above. This is not a comparison
with 0.9.1. Negative changes mean less elapsed time.

| Case | Master / candidate median | Paired time change, 95% interval | Retained | Gate |
| --- | --- | --- | --- | --- |
| Multi-thread markup | 720.65 / 679.16 ms | **−5.04%**, −6.55% to −2.62% | 16/18 | Faster; identical-code control passes |
| MDN saved-page replay | Not qualified | No qualified estimate | 11/18 | Insufficient retained rounds; minimum is 12 |

Markup's identical-code control interval is −3.07% to +2.09%; the second candidate
slot also beats master, with an interval of −8.22% to −2.95%. Thus the previously
concerning markup regression does not recur and this candidate qualifies as
faster on the tested fixture. This does not establish universal non-regression.
The other eight historical cases were not repeated and are not automatically
reclassified for this newer candidate.

Each case ran once: three calibration rounds, then 18 paired rounds with two
observations of master and each of two identical candidate slots. Orders rotate
and reverse. CPU/I/O probes filter whole rounds independently of crawl timings;
thresholds are fixed from calibration. At least 12 rounds and a control interval
within ±5% containing zero are required. Both candidate-versus-master intervals
must agree in sign. No retries, relaxed thresholds or pooling were used.
Excluded rounds were 3 and 17 for markup, and 1, 6, 8, 9, 12, 13 and 17 for MDN
(zero-based). Output fingerprints matched throughout both cases.

No tests, corpus processing, cleanup or profiling overlapped timed runs. Host CPU
samples were 13/14/10% before, 12/37/8% after the two cases, and 22/13/13% at the
final snapshot. Sampled disk queues were zero. This was best-effort measurement,
not a continuously verified idle-host release gate. The MDN failure is retained.
See [historical whole-engine results](uri-investigation-history.md) for the
older ten-case campaign; its gains must not be pooled with these results.

## Remaining merge requirements

1. Run clean-install CI on the final reviewed revision across the repository's
   runtime matrix. Local package/runtime checks substantially reduce this gap
   but do not replace CI.
2. Review the documented breaking API/parser policy. URIjs internal data structures
   are an accepted non-goal; public behavior remains the compatibility contract.
   Consumers must migrate URI imports/types; the MDN consumer migration patch is available.
   The unreleased changelog now states this change explicitly.
3. Decide the performance requirement for merge. If MDN non-regression is a hard
   gate, obtain one controlled-host result before merging. This host has not
   established it; repeated noisy runs should not be used to manufacture a pass.

There is no evidence here requiring WASM, replacing the native parser, abandoning
chaining, or reproducing all URIjs extensions before review. Ordinary string
fields and existing fast paths remain. Further code optimization requires a
relevant profile and a measurable target, not just unresolved noisy timing.

Six final Node built-in CPU profiles (one second each, requested 100 µs sampling,
checkpoint and candidate across three corpus operations) support that decision.
Candidate resolution spends about 61% of sampled self time in native parsing;
normalization spends about 24% there, 9% in hostname normalization and 6% in path
recoding. The segment-rewrite probe spends about 27% in `segment()`, but that
isolated probe does not establish an engine hotspot. These diagnostic profiles
do not establish timing gains, and do not justify another speculative fast path.

## Evidence and temporary-file cleanup

Compact validation/provenance is in [the audit evidence](evidence/uri-merge-readiness.json).
Full corpus reports, profiles, paired observations, controls and host samples
remain under `/mnt/e/tmp/wse-uri-merge-audit-20261005`.

An initial stale-build probe was aborted. Later, a full temporary drive interrupted
runtime extraction and corpus report writes; those attempts are discarded and
the completed replay above supersedes them. Disposable old caches, extracted MDN
copies and duplicate archives were pruned. Original MDN archives, accepted input
manifests, source snapshots, dependency trees and result evidence were preserved.
The cleanup manifest records every removed path and byte count.

CI preparation logs are under `/mnt/e/tmp/wse-uri-ci-prep-20261005`. The workflow
runs on pushes to `feat/native-url-compat` and `master`, plus pull requests to
`master`. Preparing the branch does not itself start a remote CI run.
