# Engine-only performance investigation — 2026-10-01

Superseded by the subsequent [relaxed-defaults measurements](performance-defaults.md),
following authorization to trade defensive checks and atomic output for speed.

**The requested all-suite improvement over 0.9.1 is not achieved.** The changes
below improve engine hot paths, but they are not a passing performance assessment
for releasing 0.10.0. MDN's previously committed cleanup optimization is retained
and excluded from this comparison: all MDN variants use the same original cleanup
source so the measurements isolate the engine.

## Engine changes

- Compute relative replacement paths directly for ordinary ASCII local filenames.
  Encoded characters, query/hash delimiters, dot segments, Windows drive paths and
  other unusual inputs continue through URIjs. Every resource gets its own URI.
  Differential tests compare 3,721 path pairs with URIjs, including directory,
  parent, encoding and platform cases.
- Reuse a response resource's parsed URI when its string exactly matches the
  recorded response URL. Changed URLs still get parsed before alias retention.
- Recognize the built-in legacy full-path adapter when it is the first save-path
  hook and skip the default path it unconditionally replaces. Earlier transforming
  hooks still receive the default path. Hook order and reference paths are tested.
  Recognition uses a WeakSet in a small internal module; it does not import the
  HTML adapters into the executor.

Two replacement-path caching experiments were rejected: a 256-entry cache and
a one-entry cache improved repetitive markup but added MDN overhead. Neither is
in the final implementation. Output containment, publication, cancellation,
worker startup and pool lifetime were not changed.

## Measurements

Node 24.18.0, serial runs, alternating variant order, a discarded warm-up and
explicit GC between samples. CPU profiling was separate from elapsed-time runs.
The old baseline is the existing 0.9.1 build; the prior engine is `5e15fc3`.
Raw data and final source fingerprints are in
[the evidence file](evidence/engine-performance-followup.json).
Local artifacts are under `artifacts/wse-engine-profile-20261001`.

Final five-sample synthetic median total milliseconds, including initialization
and disposal, with identical output hashes and file/request counts:

| Mode | Workload | 0.9.1 | Prior 0.10 | Candidate |
| --- | --- | ---: | ---: | ---: |
| Single | Buffered | 72.8 | 89.8 | 83.6 |
| Single | Streamed | 104.3 | 120.3 | 127.3 |
| Single | Local | 14.2 | 22.4 | 23.1 |
| Single | Markup | 277.3 | 299.6 | 270.7 |
| Multi | Buffered | 386.3 | 393.2 | 414.6 |
| Multi | Streamed | 161.0 | 457.8 | 412.6 |
| Multi | Local | 323.9 | 337.2 | 329.6 |
| Multi | Markup | 550.3 | 614.1 | 611.0 |

An earlier seven-sample run of the path/alias changes, before the legacy adapter
optimization, measured single markup at 298.3 / 321.7 / 286.1 ms and multi markup
at 742.6 / 886.9 / 722.7 ms. Thus the markup improvement against prior 0.10 repeats,
but the multi-thread win against 0.9.1 does not. Short HTTP/filesystem fixtures
vary significantly across runs; all raw samples, including slower results, are
retained. No all-suite pass is inferred from the favorable samples.

The markup CPU profile reduced inclusive `createResourceWithUris` samples from
406.3 to 127.3 ms across nine runs; the new replacement calculation accounted for
61.8 ms. This profile predates the adapter optimization but uses the final
replacement-path and alias code. Full-process profiles include imports, GC and
benchmark hashing, so these are sampled costs, not crawl CPU percentages.

MDN depth-zero replay uses the real lifecycle/downloader and 12 distinct paths
containing the saved Using_images document. Network is blocked and bootstrap
seeding is omitted. It is not a full remote MDN archive. All variants share the
remaining MDN workspace dependencies and adapt the legacy save-path API where
required. All saved output hashes remain identical.

| MDN probe | 0.9.1 | Prior 0.10 | Candidate |
| --- | ---: | ---: | ---: |
| Nine-sample full replay, ms | 1467.8 | 1645.1 | 1487.1 |
| Five-sample 3,980-link probe, ms | 546.4 | — | 523.5 |

The engine improves the link probe, but full MDN replay is still 1.3% slower
than 0.9.1 in the final run. It does not satisfy the requested target.

Other probes:

- Queue: p-queue 8 versus 9, five alternating samples. Immediate tasks: 71.3 versus
  62.7 ms. Yielding tasks: 16.2 versus 19.5 ms. The latter remains a regression;
  these are dependency-level probes, not crawl timings.
- Options: 12,000 merges took 906.4 ms, with bounded retained memory and singleton
  hooks. The historical Got probe reproduced 1,000 retained history entries.
  This checks the existing retention fix; it is not an apples-to-apples 0.9.1
  throughput pass.

## Remaining failures

Local-file persistence, streaming and several multi-thread totals still exceed
0.9.1. Publication adds checked staging and rename operations, and the multi
streaming fixture includes one-time worker readiness before parent-side streaming.
The profile also shows transport and filesystem waiting. These costs explain
where further work is required; they are not accepted exceptions to the user's
performance target. No benchmark was changed to hide initialization, cleanup or
correctness checks.

## Validation

The final candidate passes all 424 tests in 36 suites on Node 22.13.0, including
worker lifecycle, publication, cancellation, alias retention and direct
single-thread import checks. The isolated Node 24.18.0 build passes. Source
fingerprints match the benchmark copy. No dependencies were added or changed.
