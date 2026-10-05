# URI wrapper merge status

Runtime revision `3c7247a` completed merge validation. The user approved local
merge after reporting CI passing for that pushed revision. No GitHub API polling
was performed. This closeout changes documentation only. The migration remains a breaking, best-effort URIjs
replacement with documented native parsing differences.

## Final validation

| Check | Result |
| --- | --- |
| Linux Node 22 build, lint and strict test types | Pass |
| Full Jest, Linux Node 22 | 1,018 tests / 50 suites passed |
| Full Jest, native Windows Node 24 | 1,017 passed, one existing platform skip / 50 suites |
| Focused resource/output suites, Linux Node 26 | 94 tests / 3 suites passed |
| Fresh packed consumers, Linux Node 22/26 | Strict declarations and 13 runtime checks each passed |
| Fresh packed consumer, Windows Node 24 | Strict declarations and 14 runtime checks passed |
| CI on pushed runtime revision | Passed, as reported by the user |

Validation used an isolated snapshot excluding unrelated untracked drafts.
Source/snapshot and compiled/packed files matched. No dependency was added.
[Final validation evidence](evidence/output-link-fix.json) records hashes and logs;
[earlier CI portability evidence](evidence/uri-ci-hostname.json) explains native
IDNA differences and Windows fixture corrections.

## Output and compatibility

The [offline MDN output audit](mdn-output-compatibility.md) replays 476,068
artifact/log cases through the real MDN hooks without a crawl. Before the output
fix, the migration changed no decoded filenames, resolved destinations or decoded
fragments. One Unicode spelling pair gained deduplication; 108 link spellings
changed without changing their destinations.

The subsequent reserved-filename fix removes 14 existing link mismatches and 32
file-URL conversion errors in a focused 1,000-case replay. It preserves filenames,
request URLs and deduplication keys. All 27 selected real-writer cases pass.
Full response-driven crawling and page-body behavior are outside this replay.

The public API audit retains seven documented differences in 8,452 selected
cases. All 58 core instance names are present (Latin-1 mode explicitly throws),
and 33 of 37 audited static names are present. These are selected checks and API
counts, not global equivalence percentages. See the [migration contract](native-url-migration.md)
for native parsing, optional extensions and other limits. URIjs internal storage
is an accepted non-goal.

## Performance qualification

The parts-builder fix measures 21.33% less time than the regressed source-audit
version, with a passing identical-code control. Its +1.79% estimate against
checkpoint `06d167f` remains noise-limited; formal non-regression is not established.
These direct API measurements do not establish whole-engine gains.

Earlier whole-engine measurements against URIjs master `1dd2214` qualified
multi-thread markup at −5.04% (95% interval −6.55% to −2.62%, 16/18 rounds).
The MDN replay retained only 11/18 rounds, below the required 12. These historical
snapshots predate the final output fix. Neither CI nor the merge decision turns
an unresolved performance gate into a pass. Full favorable and unfavorable
observations remain in [investigation history](uri-investigation-history.md)
and [audit evidence](evidence/uri-merge-readiness.json).

## Downstream follow-up

Apply the prepared [MDN-local migration patch](mdn-native-url-migration.patch),
update its engine/logging dependencies, then check its build and a small offline
output fixture set. A full crawl is not required solely to approve the migration.
No downstream checkout was changed by this work.

Raw evidence, source snapshots, corpus inputs and dependency trees remain in the
recorded task directories. Disposable caches and generated writer fixture trees
were removed at closeout; [the cleanup manifest](evidence/uri-merge-cleanup.json)
records the paths. The fixture inputs and replay scripts remain reproducible.
