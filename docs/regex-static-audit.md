# Input-dependent complexity audit — 2026-10-06

Baseline: `ed130d6`. Manual review covered 60 runtime source files, 57 regex
literals inventoried through the TypeScript AST, and input-dependent loops.
This is not a CodeQL run; the CLI is unavailable. Dependencies are outside scope.

## Changes

| Input / API | Original failure | Final implementation |
| --- | --- | --- |
| Segment setters | Quadratic suffix-slash trimming | Scan boundary slashes once. |
| CSS comments | Quadratic retries on unclosed `/*` openings | Monotonic delimiter search and offset-preserving masking. |
| CSS URL/import arguments | Cubic whitespace backtracking on missing delimiters | Bounded ordinary-token captures; cached delimiter searches for long/unusual inputs, including failed searches. |
| HTML refresh targets | Cubic overlapping whitespace/backtracking | Bounded quoted fast path plus separate prefix/target parsing. |
| `URI.withinString` | Quadratic failed scheme retries after hyphens | Match only at maximal scheme-run boundaries; recover numeric/punctuation prefixes at `://` delimiters. |
| Large query arrays | Nested multiset matching and removal | Ordered value buckets and membership sets; preserve first-match consumption and null/string-null asymmetry. |

CSS and refresh parsing process downloaded content. `withinString` is exported
but is not used by the built-in scraping pipeline. The final observer simplifies
normal URL handling to one native match; only unusual prefixes need backward
recovery and a lazily allocated tail matcher. Small query arrays retain their
existing paths. No dependencies or private class fields were added.

Legacy extraction, malformed-input handling, offsets and callback-visible source
are preserved. Replacements still rebuild the source because callbacks observe
that updated source; many replacements can therefore incur quadratic copying.
Caller-provided regular expressions retain caller-defined complexity.

Other reviewed patterns use bounded repetitions, anchored scans, or separators
excluded from repeated classes. This audit is not a whole-project complexity
proof. [Static evidence](evidence/regex-static-audit.json) records the inventory
and capped witnesses, including the original CodeQL segment alert.

## Performance evidence

The reusable offline runners are `scripts/benchmark-parser-short.mjs` and
`scripts/benchmark-parser-scaling.mjs`. Ordinary runs use 12 short paired rounds,
rotated/reversed ordering, whole-round noise filtering, and independent identical
code controls for both variants. Each control's 95% interval must include zero
and lie within ±5%. Host admission requires median CPU <20%, maximum <35%, and
disk queue ≤1. An idle host sample alone is not a performance pass.

The initial safe implementation had a controlled **23.6% observer regression**
and a controlled **51.7% query-heavy equality improvement**. CSS/refresh fast-path
work then produced these estimates against master:

| Workload | Time change | Evidence status |
| --- | ---: | --- |
| One CSS URL | −30.2% | Controls inconclusive |
| CSS sheet, 24 URLs | −13.2% | Controls inconclusive |
| Quoted refresh | −13.8% | Controls inconclusive |
| Raw refresh | −32.3% | Controls inconclusive |
| Common-scheme observation, before final simplification | +19.9% | Controls inconclusive |
| Generic-scheme observation, before final simplification | +20.8% | Controls inconclusive |

These are direct API measurements, not crawl/MDN throughput. Historical query
matching/removal estimates were approximately −91–92%, also with inconclusive
controls. The final observer revision estimates **+16.9% common / +20.4% generic** against
master. Against the previous candidate, estimates are +3.6% / −7.9%, respectively.
All four new runs retained 12 rounds but failed at least one identical-code
control. The simpler implementation is retained for its reduced ordinary-path
work and lazy fallback allocation; **observer regression remains unresolved**.
There is no blanket performance pass.

The capped adversarial probe corroborated removal of the original polynomial
failures. At 32,768 repetitions, the final candidate completed comments/CSS/
refresh/schemes/segments in approximately 0.312/1.600/0.097/0.448/0.130 ms.
The vulnerable baseline was deliberately not run at that size. These diagnostic
samples are not noise-qualified speedup estimates.

[Initial paired evidence](evidence/regex-fix-paired.json) and
[regression follow-up evidence](evidence/regex-regression-paired.json) retain
selected results, controls, artifact hashes and host samples. Historical source
hashes identify the measured versions; they must not be attributed to later edits.

## Compatibility and merge preparation

Final-source differential validation covers 40,000 CSS cases, 40,000 refresh
cases, 40,000 URI callback/source/offset cases and 4,500 long/boundary cases:
**124,500 checks, zero differences**. Committed tests add bounded legacy oracles,
2,000 query-array samples, threshold/nonmutation checks, long unfinished inputs,
callback reentrancy and exception recovery.

Real writer tests exercise short and long CSS/refresh targets with 32/33 spaces,
resolve emitted links as native file URLs and read the saved child bytes. They
cover `%23`, `%2F`, literal `$&` in filenames, and repeated CSS URL deduplication.
No full crawl is required for these output checks.

Local validation passes build, lint, strict test types and all 1,065 tests in 53
suites on Node 22. Windows Node 24 passes the same 53 suites (1,064 passed, one
existing skip); Node 26 passes 90 focused tests in four suites. Validation ran in
an isolated snapshot excluding unrelated local drafts; task sources/tests match
the working tree byte for byte.

[Merge preparation evidence](evidence/regex-merge-preparation.json) records final
measurements, source hashes and validation. The branch is prepared for review,
with the observer performance limitation above. CI/CodeQL alert closure remains
pending after a push. No merge or push is part of this checkpoint.
