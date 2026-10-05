# MDN artifact and log URI probe

Completed on 2026-10-05. The corpus exposed path recoding, readable-output and repeated-fragment-hash bugs. The wrapper now fixes those cases and avoids unnecessary recoding, path normalization and ASCII-host conversion. Final validation passed **989 tests in 48 suites**, lint, strict test types and build. No dependencies or private fields were added.

## Corpus and scope

- All six `developer.mozilla.org` archives under `/mnt/d/UserData/Documents/mdn-data`: English and Chinese snapshots from 2020-12-02, 2025-05-04 and 2026-10-03. Archives were read without modification.
- 1,200 deterministic artifact samples: 160 HTML, 20 CSS and 20 SVG files per archive, selected by SHA-256 of member name within file type, limited to 1.5 MB per file. Extracted URL-bearing attributes, srcsets, inline styles and CSS `url(...)` references; HTML entities are decoded by Cheerio.
- Artifacts supplied 197,152 URL occurrences, 35,312 distinct strings and 180,171 distinct input/base pairs. Nine occurrences longer than 8,192 characters were omitted; srcset parsing had no errors.
- All 42 crawl logs were scanned, including request, response, skip, retry, 404, error and completion logs: 4,106,830 extracted occurrences and 295,897 distinct probe cases. The log corpus includes failed and skipped URLs absent from downloaded pages.
- Logs mix resource, download, referring and raw URLs. Explicit `skipped incorrectly parsed url` fields retain their raw text and parent context. Scheme-bearing tokens and quoted Node URL fields are also included, without claiming each is raw. Quoted values are decoded, serialization punctuation is removed, protocol-only fields are excluded, and known URL columns recover embedded spaces. Unlabeled arbitrary relative strings cannot be recovered reliably; this is not a complete reconstruction of the original crawl inputs.
- Artifact bases are derived from their archived paths, removing outer package directories. They are replay contexts rather than proof of every original remote response URL. This is an offline API probe, not a live crawl or full content comparison. Page and log corpora are counted separately and can overlap.

The final probe made **11,851,658 API comparisons**. All **476,068 raw input/base constructor checks** matched `new URL(input, base)`. Resolved relative-link round trips also passed. Three logged malformed HTTPS strings differ when parsed *before* `.absoluteTo(base)` versus resolving their raw text directly; that two-stage distinction is now tested explicitly.

The probe compares raw lexical inputs and separately compares public methods on the same native-canonicalized input. It covers parsing, components, decoded paths, filename/directory/suffix helpers, segments, queries, normalization, display, mutations, predicates and resolution. Raw string differences remain visible; it does not silently canonicalize away failed API outputs.

## Fixes and regression tests

1. Explicit path normalization now recodes path segments like URIjs, including parentheses, asterisks and encoded reserved characters. Trailing dot segments retain directory semantics; a canceled relative directory becomes empty.
2. Filename, directory and suffix setters recode only the replacement. Segment setters recode the whole resulting path. A regression test prevents accidental rewriting of untouched components. Direct `path()` setters retain the existing native/lexical policy.
3. `readable()` normalizes a copy, removes credentials, decodes query spaces, and preserves encoded path separators and query ampersands. It leaves the source unchanged.
4. Fragment normalization preserves repeated leading hashes such as `##the-future-pseudo`, including across repeated normalization and readable output.

The new suite includes **256 fixed URIjs-derived expectation cases** (247 from archived artifacts/logs and 9 reduced boundary cases); **254 fail on the starting wrapper**. Additional tests cover component scope, mutation/cache consistency, dot segments, malformed escapes, query-space flags, numeric/IDN hostnames, opaque limitations and malformed scheme resolution. The total suite grew from 706 to 989 tests.

For native-canonicalized log URLs:

| API operation | Starting mismatches | Final mismatches | Remaining reason |
| --- | ---: | ---: | --- |
| normalize() | 1,595 | 5 | Five percent-encoded unreserved fragment spellings; wrapper normalizes these, URIjs does not. |
| readable() | 679 | 1 | Opaque localhost:3000 retains its native scheme spelling rather than adding //. |
| segment(-1, value) | 551 | 37 | 36 native serialization differences and one unsupported opaque mutation. |
| segmentCoded(-1, value) | 551 | 37 | Same native/opaque limits. |
| normalizePath() | 1,619 | 36 | Native serialization, principally retained empty delimiters. |

Counts are comparisons, not unique bugs or API coverage percentages. The page corpus additionally contains opaque data/mailto paths: their normalization, decoded getters and mutation limits remain intentionally different. Raw Unicode/host/default-port canonicalization, empty delimiters, tolerant malformed decoding and opaque receiver-return quirks are documented in [the migration notes](native-url-migration.md). Full per-operation counts and representative differences remain in the evidence; complete URIjs compatibility is not claimed.

## Performance work

Short Node inspector profiles requested 100 µs sampling for one second per workload after warmup, using 256 deterministic artifact URLs. They ran separately from tests, corpus probes and elapsed-time measurements. The corrected, unoptimized snapshot is retained separately from the starting wrapper.

- Path recoding initially spent roughly 40% of normalization self samples in splitting/decoding/recoding. A guarded ASCII path check now returns unchanged text directly; dot-segment and repeated-slash checks skip unnecessary `posix.normalize` work. Encoded, Unicode and unusual paths retain the slow path.
- After that reduction, hostname conversion became prominent. Plain ASCII hostname normalization now lowercases directly; numeric, Punycode, encoded and internationalized hostnames retain native conversion. Existing hostname guards are reused.
- Final normalization profiles are led by native parsing; `domainToASCII` no longer appears among the top 25 self frames for this corpus. Native parsing still dominates resolution. Segment-array work remains visible in the segment-setter workload, but that setter is not an identified engine hot path. No parser replacement or WASM kernel is justified by these profiles.

**All six final identical-code controls failed. No new elapsed-time improvement or regression is established.** The estimates below are descriptive. The starting-wrapper comparisons use only inputs with identical outputs on all APIs; one incompatible input is omitted from normalization and resolution. The exclusions are recorded before timing and are separate from noise filtering.

| Workload | Comparison baseline | Paired time change | 95% interval | Time vs URIjs | Retained | Control 95% interval |
| --- | --- | ---: | --- | ---: | ---: | --- |
| normalize | Corrected, unoptimized | -60.54% | -67.02% to -52.26% | -77.17% | 16/16 | -15.56% to +33.43% |
| rewrite | Corrected, unoptimized | -46.04% | -50.33% to -37.62% | -64.21% | 13/16 | -23.40% to +15.78% |
| resolve | Corrected, unoptimized | -5.73% | -23.11% to +11.39% | -82.23% | 14/16 | -29.95% to +18.81% |
| normalize | Starting wrapper | -46.36% | -63.50% to -36.46% | -77.02% | 16/16 | -9.58% to +74.52% |
| rewrite | Starting wrapper | -17.47% | -39.41% to +3.52% | -66.32% | 16/16 | -18.41% to +26.64% |
| resolve | Starting wrapper | -23.81% | -31.80% to -4.87% | -85.94% | 14/16 | -27.93% to -0.83% |

`rewrite` here means a direct segment replacement and fragment clear, not an engine crawl. URIjs comparisons are equally unresolved because their controls failed. Resolution code was unchanged, so its large apparent movements are a useful illustration of the host noise.

Each case used four API slots (URIjs 1.19.11, comparison wrapper, final wrapper, identical-final control), rotated/reversed order, exact output preflight and consumed checksums. Four calibration rounds precede 16 fixed measured rounds, targeting 12 ms for the slowest batch. Whole rounds are excluded using bracketing probes or a 250 ms round limit; at least 12 are required. The 10,000-resample bootstrap control interval must contain zero and lie within ±5%. No failed timing case was retried on the same snapshot.

An earlier six-case timing pass also failed every control. A subsequent source change—the ASCII-host optimization—justified the final pass; all earlier results are preserved. Host CPU immediately before final timing was 26%, 47%, and 28%, with zero total disk queue in those sparse samples. These measurements are not a quiet-host release gate.

These are direct API diagnostics. The earlier [whole-engine versus master report](master-wrapper-performance.md) measured the preceding source snapshot; its percentages are not updated or combined with this work.

## Evidence and reproduction

- [Regression cases](../test/fixtures/mdn-uri/regressions.json) and [test suite](../test/uri-mdn.spec.ts) run without URIjs or the archives.
- [Probe script](../scripts/probe-uri-corpus.mjs): `node scripts/probe-uri-corpus.mjs URIJS_ENTRY WRAPPER_ENTRY INPUT_JSON OUTPUT_JSON`. Input records contain `input`, `base`, and optional archive/member/line provenance. Use the wrapper `lib/uri.js` entry.
- [Evidence JSON](evidence/mdn-uri-probe.json) includes archive-member hashes, collection rules/scripts, every per-operation count, sample differences, all final and earlier timing rounds, profiler summaries, exact runtime hashes, and paths/hashes for full raw probe reports and corpora.
- Full artifacts remain under `/mnt/e/tmp/wse-mdn-uri-probe-20261005`. Node 22.13.0 and existing shared dependencies were used; no dependency additions or package changes were made for this task.

Initial extraction issues (outer archive directories and Node inspection punctuation) were corrected before the accepted before/final corpus comparisons. The first helper implementation recoded too much of the path; the broad probe detected it and the component-scope test now guards it. Local validation setup failures and superseded reports remain in the task logs. Final source/build hashes were verified unchanged through the final probe and measurements. The unrelated `src/shared-context.ts` draft was preserved and excluded from validation snapshots.
