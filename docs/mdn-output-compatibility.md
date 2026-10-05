# MDN output compatibility without a crawl

The migration gate should compare what a local reader opens: disk filenames,
rewritten link destinations (including decoded fragments), and deduplication
groups. URI API equivalence alone does not establish these properties.

The focused fix below now resolves the reserved-character defects found by the
original replay. The original measurements are retained as before-fix evidence.

`scripts/probe-mdn-output.mjs` replays existing extracted inputs through each
engine's actual MDN redirect, resource-type, save-path and pre-download hooks.
It uses the actual downloader key function and the writer's `decodeURI` filename
rule. The link check independently resolves the emitted reference from the
decoded parent filename with Node's standard file-URL conversion.

No crawler, body fetching or network requests run. Missing bodies outside the
sample are not treated as broken links. Optional `--publish` exercises the real
HTML/resource writers on small fixture bodies, reads the emitted parent HTML,
and verifies that its link opens the expected written child content.

## Recorded comparison, 2026-10-05

The baseline is the URIjs engine at master `1dd2214`; the candidate is the native
wrapper after the credential-construction performance fix. Each uses its matching
MDN lifecycle from the prepared migration of MDN-local `a4979c8`.

| Output property | Artifact replay: 180,171 cases | Package logs: 295,897 cases |
| --- | ---: | ---: |
| Changed decoded disk filename | 0 | 0 |
| Changed resolved destination | 0 | 0 |
| Changed decoded fragment/query | 0 | 0 |
| Changed accept/discard/skip decision | 0 | 0 |
| Changed link spelling | 60 | 48 |
| Changed deduplication key | 0 | 1 |

The link spelling differences retain their destinations, for example a Unicode
fragment versus its percent encoding, or an empty self-link versus an explicit
filename. The one changed log key merges a Unicode path with its percent-encoded
spelling. Both already map to the same disk filename and rewritten destination.
There are no observed deduplication splits or new link-to-file mismatches.

The artifact replay accepts 167,751 cases, grouped into 34,999 archive-scoped
deduplication groups in both variants. The log replay accepts 193,318 cases;
groups decrease from 165,250 to 165,249. These are replay inputs/groups, not counts
of successfully downloaded pages.

The selected writer replay verifies 26 cases per engine, including representative
changed spellings and the merged Unicode key. An identical-candidate control has
zero differences. One additional diagnostic deliberately exercises a known bad
filename and reproduces the same missing target in both engines.

## Existing output issues retained in the report

- Fourteen log observations have a mismatch between the decoded output filename
  and local link destination in both variants. The writer diagnostic confirms
  one: `%23` remains literal in the disk filename because `decodeURI` preserves
  reserved characters, but resolving the link decodes it to `#`. This is an
  existing output issue, not a migration regression. It is not fourteen verified
  broken published pages; many log inputs came from historical 404 records.
- One artifact and 31 log observations fail standard file-URL conversion, notably
  encoded slashes. These are unresolved local-path cases in both variants.
- Multiple distinct URL keys can map to one filename, for example `/en-US/` and
  `/en-US/index.html`. Both variants have 173 artifact collision observations
  (184 with case folding). Log observations decrease from 588 to 587 (2,854 to
  2,853 with case folding) due to the Unicode-key merge. These are candidates for
  publication conflicts, not proof of lost content; redirects and download
  outcomes are not simulated.

An initial probe incorrectly treated archived SVG documents as HTML seeds,
producing two false deduplication/file warnings. The final probe derives document
types from artifact filenames; both warnings disappear. Initial results remain
in the local artifact directory for provenance.

## Reserved-filename fix

`urlOfSavePath` now encodes the filename after applying the writer's `decodeURI`
rule. A filename containing literal `%23` is linked with `%2523`; literal `%2F`
is linked with `%252F`. Decoded spaces, Unicode and percent signs also receive
the correct URL spelling. Saved filenames, resource URLs and deduplication keys
are unchanged. The ordinary-filename relative-path fast path is unchanged.

Redirect HTML uses the same URL spelling, without applying filename sanitization
to the finished URL. Its refresh attribute escapes HTML entities independently
of the JavaScript redirect string.

A focused replay selects all 1,000 artifact/log cases containing the tested
reserved escapes. In the accepted 144 cases, all 14 link-target mismatches and
32 file-URL conversion errors disappear. There are no new mismatches or changes
to filenames, accept/skip decisions, download URLs or deduplication groups.
The 52 changed relative-link spellings include corrections to 46 destinations;
the other spelling changes preserve the destination. Missing fragment/query
fields in the old conversion-error results become valid empty fields.

The real-writer replay now passes all 27 selected cases; the URIjs baseline still
fails the diagnostic `%23` case. Sixteen new tests exercise real HTML and binary
files with 14 encoded/literal filename pairs, plus both redirect-writing paths.
They read emitted HTML, resolve links independently and open the written files;
redirect tests also execute the generated JavaScript against a stub location.

Validation passes build, lint, strict test types and 1,018 tests in 50 suites on
Linux Node 22. Native Windows Node 24 passes 1,017 tests with one existing skip.
The 94 focused resource/output tests pass on Linux Node 26. Fresh package consumer
checks and provenance are recorded in [fix evidence](evidence/output-link-fix.json).
No full crawl or network download was needed.

## Limits and reproduction

Extracted records lack original DOM tags/attributes. Non-document `href` and log
inputs are modeled as anchors, asset inputs as image references; document seeds
use their archive file type. Log tokens are hypothetical inputs, not reconstructed
full pages. Archive filenames select locale and scope deduplication groups.
Recorded corpus order is not crawl scheduling. Post-download redirects, response
bodies, JavaScript behavior, full HTML/CSS transforms and server routing are not
covered by this check. Case folding is not a complete Windows filesystem model.

Run with absolute paths and an allowed temporary/cache directory:

```sh
node scripts/probe-mdn-output.mjs \
  BEFORE_ENGINE BEFORE_MDN_LIFECYCLE AFTER_ENGINE AFTER_MDN_LIFECYCLE \
  INPUT_JSON OUTPUT_JSON
```

Use `--publish` only with a small selected fixture set; published files are kept
beside the output report. Reports preserve differences and diagnostics instead of
silently ignoring historical failures. Compact provenance is in
[output evidence](evidence/mdn-output-compatibility.json); full reports and writer
fixtures are under `/mnt/e/tmp/wse-mdn-output-audit-20261005`.
