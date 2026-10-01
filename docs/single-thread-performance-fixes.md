# Single-thread performance fixes, 2026-10-01

This follow-up addresses repeated work in the 0.10.0 runtime at `1be0080`, using
0.9.1 and that checkpoint as separate baselines. It does not attribute mdn-local
performance to worker initialization: MDN uses `SingleThreadDownloader`. Worker
pools still initialize once and remain alive until disposal.

## Implementation

- Reuse the URI instances parsed during built-in resource creation. Keep one
  private parsed reference URL per pipeline and clone it for each resource.
  Custom factories retain their single-argument contract; save-path hook mutations
  cannot redirect a resource or leave shared mutable URI state.
- Reuse normalized resource URIs for deduplication. Avoid redundant final
  normalization and extra promise turns around synchronous link/type/before-download
  hooks; async hooks and hook-result validation remain supported.
- Normalize request options once per merge. Public plain snapshots retain explicit
  settings and init-hook changes, without expanding unchanged Got defaults into
  per-request overrides. The 12,000-merge probe fell from 1,994 to 888 ms; retained
  heap changed by about 39 KiB after warm-up, with singleton hooks and no merge
  history retained. This is a local probe, not a long-crawl memory guarantee.
- Resolve existing output parents once at each check instead of issuing one
  asynchronous lstat per directory level. Reject symlink aliases (including aliases
  within the root), and recheck immediately before rename. Missing directories
  still use checked creation. No persistent directory-trust cache is used.
- Overlapping publications in a crawl share a private staging directory per parent,
  but retain separate staging files and per-file publication/cleanup ownership.
  The last lease removes the directory before its task finishes. Failed writes do
  not delete another writer's file. There is no cross-crawl directory sharing.
- Worker logging is installed by the worker entry point. The direct
  `lib/downloader/single.js` graph imports no worker implementation. MDN's source
  import was changed from `downloader/index.js` to that direct entry. The combined
  package/downloader barrels still export and load both implementations.

For 48 local files, the parent filesystem probe recorded 48 → 2 staging-directory
allocations and 196 → 20 lstat calls. Realpath calls increased 54 → 150 because they
replace component-by-component checks. All 48 per-file renames remain. These are
JavaScript filesystem calls, not OS syscall counts. A trial sharing only in-flight
path resolutions reduced calls further but did not establish an elapsed-time gain,
so that trial was removed.

## Paired single-thread crawl results

Each run uses one discarded warm-up and five samples in alternating version order,
Node 24.18.0, concurrency eight, and the existing `benchmark-crawl.mjs` fixtures.
Imports are warm and filesystem artifacts live under `artifacts`. Every output
path/content hash, request count and expected file count matches. Times include
initialization, crawl and disposal; units are milliseconds.

| Workload | Run 1: 0.9.1 | Pre-fix | Fixed | Run 2: 0.9.1 | Pre-fix | Fixed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| buffered | 83.2 | 103.7 | 85.3 | 70.6 | 96.6 | 86.7 |
| streamed | 136.6 | 164.3 | 149.0 | 99.2 | 131.8 | 113.6 |
| local | 14.3 | 30.6 | 22.2 | 13.5 | 30.0 | 24.6 |
| markup | 370.8 | 418.6 | 365.4 | 296.2 | 350.0 | 313.7 |

The candidate improves these fixtures by 9–28% against the pre-fix checkpoint
across these two runs. It has not eliminated every difference against 0.9.1:
the 48-file local fixture still takes roughly 22–25 ms versus 13–14 ms. Buffered
HTTP and streaming also show run-dependent remaining overhead. The markup fixture
is within -1.5% to +5.9% of 0.9.1. These short fixtures do not establish WAN or
full-archive throughput, and the remaining local-file gap is not considered fixed.

## MDN lifecycle replay

The replay uses the actual mdn-local source lifecycle and MdnDownloader from the
recorded MDN revision, compiled into isolated variants with matching engine imports.
The 0.10 variants use the existing legacy save-path adapter. Other MDN dependencies
are shared between variants; this is not a clean-lock validation of mdn-local.

The input is the saved English Canvas “Using images” document from the user's
existing MDN artifacts. Twelve distinct seed paths pass through MDN's HTML
processing, link hooks, resource handling and disk persistence. Network access is
blocked, acquisitions return the saved HTML, maxDepth is zero, bootstrap asset
seeding is omitted, and concurrency adjustment is disabled. Linked-page crawling,
remote BCD/live-example acquisition, and long-running concurrency behavior are
outside this replay. Each version produces the same twelve files with identical
complete-content hashes.

| Run | 0.9.1 ms | Pre-fix ms | Fixed ms |
| --- | ---: | ---: | ---: |
| 1 | 1199.6 | 1209.2 | 1183.3 |
| 2 | 1223.6 | 1245.3 | 1231.6 |

The fixed replay is -1.4% and +0.7% relative to 0.9.1: effectively parity at this
measurement scale, not evidence of a large MDN speedup. A separate 3,980-link probe
also verifies identical URL/save/replacement results; its fixed median was 577 ms
versus 543 ms for 0.9.1. The distinction between that narrow probe and the full
HTML-processing replay is retained in the raw evidence.

## Validation and reproduction

Build and all 422 tests in 36 suites pass on Node 24.18.0 and the full tests pass
on Node 22.13.0. Native minimum-Node checks cover both downloader modes, worker
publication failures, and worker-free single-thread imports. A separate import
check blocks worker modules while loading MDN's downloader. Six stress rounds
save 2,400 files, complete 72 retries and cancel 240 queued resources, checking
buffer reservations, disposal and worker exits.

[Raw measurements and source fingerprints](evidence/single-thread-performance-fixes.json)
include both crawl runs, both MDN replay runs, the link probe, option-retention
samples and stress output. Existing `scripts/benchmark-crawl.mjs` reproduces the
engine fixtures. `scripts/benchmark-mdn-crawl.mjs` and
`scripts/benchmark-mdn-links.mjs` accept a saved HTML fixture followed by pairs of
engine entry paths and matching compiled MDN lifecycle paths; their headers give
the invocation. Set TMPDIR/TMP/TEMP, npm_config_cache and NODE_COMPILE_CACHE to an
allowed task directory before running.

The prepared local variants and logs are under
`artifacts/wse-perf-fix-20261001`; `prepare-mdn.mjs` records the source transpilation
and import adaptation used for this comparison. No dependency manifest changed,
and 0.10.0 remains unreleased. A fresh network-backed MDN archive has not been run.
