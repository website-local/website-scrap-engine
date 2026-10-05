# URI wrapper investigation history

This consolidates ten reports from the URIjs replacement work. The full original
narratives remain in Git at `634e2d2`; raw evidence is linked below. Results belong
to their recorded snapshots and must not be pooled or treated as validation of
newer code. See the [current audit](uri-merge-readiness.md) for merge status and
[the migration guide](native-url-migration.md) for the supported contract.

## Retained implementation decisions

- Ordinary string fields, independent scalar copies and cached full serialization
  replace retained native URL objects. Native URL remains responsible for absolute
  parsing, canonicalization and exceptional setter validation.
- Query codecs skip unnecessary escaping/decoding. Query builders avoid temporary
  entries and arrays; small duplicate lists use direct comparison, larger lists
  retain Sets. Named query helpers avoid temporary objects and callback wrappers.
- Encoded object-query output bypasses redundant raw-query validation. Constructor
  and resolution paths reuse serialized bases without copying/reparsing wrappers.
- Name-only query existence scans and decodes keys without parsing values. Relative
  predicates avoid unrelated IP classification.
- Guarded ASCII path/hostname checks skip redundant recoding, normalization and
  conversion. Encoded, numeric, internationalized and unusual inputs retain native
  validation. Later correctness fixes constrain these fast paths; see the audit.

Chaining syntax is not the identified bottleneck; repeated parsing/building inside
calls is. Parsed-query caching was rejected: it added mutable state and invalidation
rules without a demonstrated benefit over simpler helpers. Earlier hostname
prototypes were also rejected. The later guarded normalization shortcut is a
separate corpus-supported change. WASM, parser replacement, and additional caches
remain unjustified by profiles. URIjs internal storage such as `_parts` is an
explicit non-goal, not a missing compatibility feature.

## Historical performance evidence

Negative percentages mean less elapsed time. A failed identical-code control or
insufficient retained rounds makes an estimate unresolved, regardless of its size.
Direct API results do not establish whole-engine gains.

| Snapshot / campaign | Finding | Evidence |
| --- | --- | --- |
| Initial native wrapper, engine | MDN −21.99%, resource creation −44.36%; multi-thread markup regressed +22.77%. Superseded implementation, not a current gate. | [Initial validation](evidence/native-url-validation.json) |
| Symbol-backed wrapper, direct APIs | Absolute parse −80.25%, getters −6.29%, path/query/hash mutation −35.55%; authority mutation regressed +261.81%. | [Direct APIs](evidence/uri-direct-performance.json) |
| Expanded string-field wrapper, direct APIs | Five qualified improvements versus URIjs: parsing ~70%, getters ~17%, path/query/hash ~80%, resolution ~87%, query helpers ~22% less time. Other cases unresolved. | [Extension](evidence/uri-extended-validation.json) |
| Codec/component profiling | Removed repeated encoding, decoding and component extraction. All eight final controls failed; earlier exploratory gains remain separate. | [Profiles](evidence/uri-profile-optimization.json) |
| Query refinements / hostname prototypes | Retained three query changes; rejected both hostname prototypes. Mixed controls; retained all unfavorable estimates. | [Refinements](evidence/uri-query-refinement.json) |
| Named helpers / parsed-query cache | Retained simpler helper edits, rejected cache. Two of seven final controls passed with unresolved differences; five controls failed. | [Helpers](evidence/uri-query-helpers-performance.json) |
| Query writes / base reuse | Removed redundant encoded-query scans and wrapper-base copies; hardened public upstream suites. Snapshot-specific timings remain in evidence. | [Query/resolution](evidence/uri-query-resolution-performance.json) |
| Constructor / existence / predicates | Eliminated redundant base parsing, value parsing and IP checks. All 11 final controls failed, including a +12.50% resolution estimate. | [Target audit](evidence/uri-optimization-target-audit.json) |
| MDN corpus optimization | Retained guarded path and hostname shortcuts. All six final direct controls failed; no new elapsed-time claim. | [Corpus](evidence/mdn-uri-probe.json) |
| Pre-corpus engine versus master | Three of ten qualified faster; seven unresolved. Table below preserves the full direction of results. | [Master campaign](evidence/master-wrapper-performance.json) |

The pre-corpus baseline was master `1dd221492221db5ceffaf9be4288f94e0c16a0ee`
(0.10.0, URIjs 1.19.11), not 0.9.1. All cases used Node 22.13.0, 18 fixed paired
rounds, bracketing CPU/I/O filters and identical-candidate controls. Output
fingerprints matched. Control intervals had to contain zero and lie within ±5%.

| Historical engine case | Paired time change | 95% interval | Result |
| --- | ---: | --- | --- |
| MDN replay | −12.19% | −14.98% to −10.28% | Unresolved control |
| Resource creation | −45.86% | −48.71% to −42.52% | Unresolved control |
| Single / buffered | −10.48% | −18.01% to −0.26% | Unresolved control |
| Single / streamed | +2.02% | −0.79% to +10.53% | Unresolved control |
| Single / local | +0.34% | −3.47% to +2.76% | Unresolved control |
| Single / markup | −7.99% | −11.75% to −3.24% | Faster |
| Multi / buffered | −5.95% | −10.40% to −4.46% | Faster |
| Multi / streamed | +0.71% | −11.14% to +7.49% | Unresolved control |
| Multi / local | −9.41% | −10.20% to −6.67% | Faster |
| Multi / markup | +0.27% | −3.92% to +2.48% | Unresolved control |

The current audit separately qualifies multi-thread markup as 5.04% faster;
its MDN repeat retains too few rounds. Neither result reclassifies other cases.

## MDN corpus methodology

Six English/Chinese archives dated 2020-12-02, 2025-05-04 and 2026-10-03 were read
without modifying their originals. SHA-256 member ordering selected 160 HTML,
20 CSS and 20 SVG files per archive, at most 1.5 MB each: 1,200 files total.
URL attributes, srcsets, inline styles and CSS URLs yielded 197,152 occurrences,
35,312 distinct strings and 180,171 input/base cases. Nine occurrences exceeding
8,192 characters were omitted. Cheerio decoded HTML entities.

All 42 package logs yielded 4,106,830 occurrences and 295,897 probe cases,
including failed/skipped URLs. Explicit raw-URL fields preserve text and parent
context; other recognized URL fields are not all raw. Quoted Node values are
decoded and serialization punctuation removed. Unlabeled relative strings cannot
be reconstructed reliably. Artifact bases use archived paths without outer package
directories; these are replay contexts, not proof of original response URLs.
This is an offline API probe, not a live crawl; page/log cases may overlap.

The probe compares raw lexical inputs separately from public operations on native
canonical inputs. Initial extraction errors were corrected before the accepted
corpus. Path recoding, component-scope mutation, readable output and repeated hash
bugs gained regressions. The current audit adds text-directive preservation and
reports the latest counts. Old normalization differences are not current policy.

Run `node scripts/probe-uri-corpus.mjs URIJS_ENTRY WRAPPER_ENTRY INPUT_JSON OUTPUT_JSON`
with `{input, base, ...provenance}` records. Collection rules, member hashes, scripts,
per-operation failures, profiles and retained controls are in the corpus evidence.
Original inputs/manifests and result reports remain under
`/mnt/e/tmp/wse-mdn-uri-probe-20261005`; disposable extracted archive copies were
pruned. New validation artifacts are under `/mnt/e/tmp/wse-uri-merge-audit-20261005`.
