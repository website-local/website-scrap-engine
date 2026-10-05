# MDN URI regression cases

`regressions.json` contains reduced URL cases discovered by probing six archived
MDN snapshots (English and Chinese, 2020-12-02, 2025-05-04, 2026-10-03), including
all 42 crawl logs. Each artifact-derived case records its archive, member and,
for logs, line number. Additional cases exercise delimiter and Unicode boundaries.

Expected strings were obtained from URIjs 1.19.11 public APIs. No archived HTML,
log bodies or third-party implementation code is included here. The local test
suite uses these fixed expectations and requires neither URIjs nor the archives.

The cases cover explicit normalization, readable output, and segment mutations.
`uri-mdn.spec.ts` also checks component mutation scope, repeated normalization,
cache invalidation, retained native parsing differences and opaque-URL limits.
These are selected regression cases, not a claim of complete URIjs compatibility.

The full corpus methodology, remaining differences and performance results are
recorded in `docs/uri-investigation-history.md`. `scripts/probe-uri-corpus.mjs` can repeat the
API probe using a local URIjs entry, wrapper entry and JSON input corpus.
