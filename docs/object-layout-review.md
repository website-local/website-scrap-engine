# Object layout and review follow-up: 2026-10-27

The review retains direct resource assignments and spread copies, fixes local
path boundaries and streaming-hook replacement ownership, and adds no runtime
fields or classes. The follow-up is based on the committed quality pass
`02aa10988cce6fece625b001d393f0c4da08a376`. Measurements use the existing Linux
Node 22.22.2 and 24.18.0 runtimes and dependencies.

## Review fixes

| Trigger | Corrected behavior |
| --- | --- |
| A streaming before-download hook returns a distinct resource without a body | Download its URL to its save path, honor discard state, transfer task/publication ownership, propagate the outcome, and clear its document after success or failure |
| A local mount contains `..assets/page.html` or another filename beginning with two dots | Accept the contained filename; reject actual parent-directory traversal |
| An explicit file URL or referring file URL escapes `localSrcRoot` through a shared directory prefix or encoded dot segments | Check containment after URL decoding and path normalization |
| `io.safeJoin` receives the filesystem root as its output root | Accept paths below that root |

The streaming regression covers separate and shared documents, discard, and a
failing after-download hook. It failed on the prior implementation in all four
cases. The local-mount regressions also fail before their fix. File-URL cases
cover encoded traversal and Windows drive spelling on the two Linux runtimes;
native Windows execution remains unqualified.

`PipelineExecutor.replaceResource(previous, next): Promise<void>` is now part
of the public interface. The existing executor already implements it; custom
executors must expose the same ownership operation. See the
[migration guide](../MIGRATION-0.10.0.md#lifecycle-dependencies-and-document-ownership).

## Property-access observations

The combined diagnostic inventory contains 152 recordings, 4,669 registered
access sites and 3,458 executed sites in 43 source files. The final static
inventory covers all 54 production TypeScript files: 15 classes, 84 interfaces,
one named object type literal and 233 object-literal expressions. Only the
`PipelineExecutor` interface member list changed in this follow-up. Interfaces
and expression counts describe source structure; they are not object allocations.

Representative baseline access buckets on Node 22 are shown below. A runtime
object may appear under several static types, so these are access events and
must not be added as counts of independent objects.

| Receiver bucket | Reads | Writes | Bulk reads | Observed layout |
| --- | ---: | ---: | ---: | --- |
| `NativeUri` implementation's `this` | 366,236 | 552,292 | 0 | Fast |
| Pipeline implementation's `this` | 299,381 | 676 | 0 | Fast |
| Downloader base implementation's `this` | 259,822 | 3,197 | 0 | Fast |
| `Resource` | 140,260 | 28,153 | 5,494 | Fast and dictionary |
| `StaticDownloadOptions` | 104,324 | 0 | 0 | Fast |
| Output ownership record index | 2,318 | 1,172 | 0 | Fast and dictionary |

The extended diagnostic suites add 256 passing tests per runtime and exercise
source maps, local mounts, query records, native HTTP, cache handling and logging.
Additional sitemap, SVG and refresh pipelines produce identical output and
discoveries in the baseline, instrumented and direct-assignment builds.

The recovered CPU recordings contain seven profiles per runtime: 10,814 samples
on Node 22 and 9,689 on Node 24, including 861/642 engine self-samples. URI
construction, resource creation/normalization, wire validation and HTML
processing are visible engine work. Dependencies, I/O and startup dominate
the overall recordings.

Instrumentation changes execution. These counts do not measure time, allocation
or inline-cache polymorphism. Optional chains, parameter destructuring,
enumeration and dependency internals are not comprehensively observed. Array
element kinds and Map/Set backing storage require separate measurements.

## Actual layouts and retained heap

Direct assignments replace the temporary `Object.assign` input in
`normalizeResource` while preserving its input identity. On actual HTTP worker
resources, the same 27 own properties remain fast before and after markup
processing. The baseline enters dictionary mode; no extra object copy is needed.
Prefetched-body worker resources have 22 properties and remain fast even in the
baseline, so their result must be kept separate from the HTTP case.

| Runtime object | Own properties | Observation on both runtimes |
| --- | ---: | --- |
| HTTP worker resource, baseline | 27 | Dictionary |
| HTTP worker resource, direct assignments | 27 | Fast |
| Single / multi downloader | 23 / 28 | Fast |
| Worker pool / worker record | 22 / 5 | Fast |
| Representative normalized options | 33 | Fast |
| Temporary options merge using `Object.assign` / spread | 33 / 33 | Dictionary / fast |

The 33-property options fixture is representative, not fully populated. Earlier
44-property normalized and 47-property worker option fixtures also remain valid
historical observations. Retry metadata after deleting errors, dynamic indexes
and some external objects can remain dictionary-backed; changing their semantics
solely to force a layout is unwarranted.

Five fresh processes per variant/runtime each retained 20,000 worker-resource
graphs, using a wire snapshot from a real HTTP download and distinct resource
paths. Each process warmed 2,000 resources and compared `heapUsed` after two
full GCs before and after allocation. Every baseline object was dictionary-backed;
every direct-assignment object was fast.

| Runtime | Baseline median bytes per graph | Direct-assignment median | Reduction |
| --- | ---: | ---: | ---: |
| Node 22.22.2 | 3,185.3 | 1,821.5 | 1,363.8 |
| Node 24.18.0 | 3,208.7 | 1,854.4 | 1,354.4 |

These are retained JavaScript graph measurements, including three URI wrappers,
metadata, strings, binary wrappers and holder-array slots. They exclude external
body backing stores, DOM/Wasm allocations, worker queues and whole-crawl RSS.
They are not shallow Resource sizes or allocation-rate measurements.

## Timing decisions

The fixed crawl comparison used 24 samples per variant/mode/runtime with
rotating order, an identical control and discarded warmups. Its markup workload
downloads 24 HTML pages plus CSS, SVG and binary children, producing 96 files.
All 384 measured cases matched the same output fingerprint; warmup outputs were
checked too. Ratios below are direct-assignment elapsed time divided by baseline
elapsed time, with 95% paired-log-ratio intervals.

| Runtime | Downloader | Ratio | 95% interval |
| --- | --- | ---: | --- |
| Node 22.22.2 | Single | 0.998 | 0.973–1.023 |
| Node 22.22.2 | Multi | 1.003 | 0.970–1.037 |
| Node 24.18.0 | Single | 0.955 | 0.899–1.016 |
| Node 24.18.0 | Multi | 1.011 | 0.980–1.042 |

Every interval includes 1. Predeclared gates require CPU/wall time of at least
0.85, at most one externally busy core, and at least 12 qualified blocks for
adoption. Qualified subsets also establish no reliable speedup; the Node 24
single-downloader subset has only nine blocks.

Earlier expression microbenchmarks favored direct assignment and spread, but
their controls and host qualification limit broader timing conclusions. The
retained changes simplify construction and improve the measured worker layout
and retained heap. They establish no overall crawl throughput improvement.

Extra worker copying showed no reliable improvement over direct assignments and
was rejected. Hoisting wire-validation field arrays also showed no consistent
benefit, with some decode comparisons slower. Rebuilding lookup tables as fast
objects was slower in the earlier experiment. The existing 30-pair
[HTML link-array experiment](performance.md#html-link-array-experiment-2026-10-25)
already found no reliable gain; `links = [attrValue]` remains unchanged.

The timing builds precede the later streaming-hook fix and final uninitialized
local cleanup. The measured resource/option implementations are unchanged in
the qualified package; those timings do not benchmark that entire final package.

## Final validation and evidence

Both runtimes pass build, lint, strict source/test types and **53 suites / 1,138
tests**. The packed engine passes strict declarations and all 15 consumer check
groups, including both downloaders, logging and all 16 GroveDOM ownership/pool
cases per runtime. All 216 emitted build files match across runtimes; all 276
engine package files and 37 published GroveDOM 0.1.2 files match their evidence.

The local evidence root is
`/mnt/e/temp/engine-session-complete-20261027-UX5QAP/`. Its `REPORT.md` and
`RESULT.json` index the raw profiles, source hashes, test logs and package.
Key summaries under `evidence/` are `access-summary.json`, `cpu-summary.json`,
`final-source-inventory.json`, `http-worker-shapes-summary.json`,
`retained-worker-memory-summary.json`, `benchmark-summary.json` and
`artifact-verification.json`. The previous session evidence remains preserved
and is identified by input hashes in those summaries.

Temporary source/build/package copies were removed after the final consumer
checks. Recorded results, source hashes and validation summaries remain. The
later concurrent-observer and cached-prefix changes are documented separately
in the [performance notes](performance.md#prefix-and-promise-measurements-2026-10-27).

The [GroveDOM qualification](grovedom.md#review-follow-up-qualification-2026-10-27)
is separate from the older engine/MDN replays. Cheerio remains the default;
full-archive/browser validation and an admissible consumer performance
measurement remain adoption requirements.
