# MDN output compatibility without a crawl

The final reserved-filename fix makes local links and redirect pages reach the
actual written files, preserving saved names and deduplication keys. The audit
uses existing MDN artifacts/logs and small real-writer fixtures, without fetching
bodies or starting a crawler. Final validation is in the [merge status](uri-merge-readiness.md).

## Broad replay before the output fix

The URIjs baseline is master `1dd2214`; the native candidate includes the
credential-builder performance fix. Each uses its matching MDN lifecycle from
the prepared migration of MDN-local `a4979c8`.

| Output property | Artifacts: 180,171 cases | Logs: 295,897 cases |
| --- | ---: | ---: |
| Changed decoded disk filename | 0 | 0 |
| Changed resolved destination | 0 | 0 |
| Changed decoded fragment/query | 0 | 0 |
| Changed accept/discard/skip decision | 0 | 0 |
| Changed link spelling | 60 | 48 |
| Changed deduplication key | 0 | 1 |

The 108 spelling changes preserve their destinations. One Unicode path merges
with its percent-encoded spelling, already mapped to the same disk filename.
There are no observed deduplication splits or new link-to-file mismatches.
Artifact inputs yield 167,751 accepted cases and 34,999 archive-scoped groups in
both variants; logs yield 193,318 accepted cases, with groups decreasing from
165,250 to 165,249. These are replay counts, not successful downloads.

## Reserved-filename correction

Both engines initially had 14 log link mismatches and 32 file-URL conversion
errors (one artifact, 31 logs). Writers use `decodeURI`, preserving reserved
escapes such as `%23`, whereas the old links interpreted them as URL escapes.
The writer diagnostic reproduced a missing file: the disk contained literal
`%23`, but the link resolved to a filename containing `#`.

`urlOfSavePath` now URL-encodes the writer's decoded filename: literal `%23` is
linked with `%2523`, and literal `%2F` with `%252F`. Spaces, Unicode and percent
signs also retain their proper meaning. Redirect writers preserve the completed
URL and escape HTML attributes separately. The ordinary-filename fast path is
unchanged.

The focused replay selects all 1,000 artifact/log cases containing the tested
reserved escapes. Its 144 accepted cases have **zero remaining link mismatches
or conversion errors**, with no changed filenames, decisions, download URLs or
deduplication groups. Of 52 changed link spellings, 46 correct destinations;
the others preserve their destinations. Former conversion errors now have valid
empty fragment/query fields.

All 27 selected real-writer cases now pass, including the previously failing
`%23` diagnostic. Sixteen new tests cover 14 filename pairs through HTML and
binary writers, plus both redirect-writing paths. They read emitted HTML,
resolve links independently and open the written files; redirect tests execute
the generated JavaScript against a stub location. An identical-candidate replay
control has zero differences.

## Remaining limits

Distinct keys can still share a filename, such as `/en-US/` and `/en-US/index.html`.
The broad replay records 173 artifact collision observations (184 with case
folding), and 588 → 587 log observations (2,854 → 2,853 with case folding).
The decrease follows the Unicode-key merge. These are existing conflict
candidates, not verified lost files; redirects and download outcomes are not
simulated. Many problematic log inputs are historical 404s.

Extracted inputs lack original DOM tags/attributes. Hrefs/log tokens are modeled
as anchors, asset references as images, and document seeds use archive file types.
An initial SVG-as-HTML classification produced two false warnings; both disappear
in the corrected replay. Archive names select locale and deduplication scope;
corpus order does not reproduce crawl scheduling. Missing unsampled bodies are
not counted as broken links. Post-download redirects, full HTML/CSS transforms,
response bodies, browser JavaScript and server routing are outside the replay.
Case folding is not a complete Windows filesystem model.

## Reproduction and evidence

`scripts/probe-mdn-output.mjs` runs actual MDN pre-download hooks, save-path
rules and downloader key generation. It checks writer-decoded paths against
standard file-URL resolution. Use absolute paths and configured local temp/cache
directories:

```sh
node scripts/probe-mdn-output.mjs \
  BEFORE_ENGINE BEFORE_MDN_LIFECYCLE AFTER_ENGINE AFTER_MDN_LIFECYCLE \
  INPUT_JSON OUTPUT_JSON
```

For a small selected fixture set, `--publish` invokes real HTML/resource writers
and verifies emitted links against written content. Reports retain diagnostics.
[Original output evidence](evidence/mdn-output-compatibility.json) and
[fix evidence](evidence/output-link-fix.json) contain hashes, counts and provenance.
Full inputs/reports remain in `/mnt/e/tmp/wse-mdn-output-audit-20261005` and
`/mnt/e/tmp/wse-output-link-fix-20261005`. Generated writer files were removed
at closeout; the recorded inputs and script reproduce them.
