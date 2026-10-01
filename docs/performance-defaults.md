# Relaxed performance defaults — 2026-10-01

This follow-up implements the user's authorization to relax runtime checks,
make direct writes the default, normalize resources only at worker boundaries,
and remove worker message versioning. It improves several workloads against
0.9.1, but the requested all-suite performance target remains unmet.

## Defaults and tradeoffs

| Setting | Default | Opt-in behavior |
| --- | --- | --- |
| `atomicWrites` | `false`: write to the destination; failure/cancellation can leave partial output and replace cached bytes | `true`: stage each file and rename on success |
| `strictOutputChecks` | `false`: resolve roots and prepare directories once per crawl; the output tree must remain stable | `true`: resolve roots and check parents before each write |
| `waitForWorkers` | `false`: create one pool on the first worker task and retain it until disposal; streaming-only crawls create no workers | `true`: initialize workers and await readiness during downloader initialization |

Atomic publication always rechecks its parent before rename. Direct output
rejects an existing destination-file symlink. Root containment, task ownership,
payload checks, cancellation and configured resource/body limits remain.
Standalone publication helpers without a downloader context remain atomic.

Direct save policies run before output is opened. HTTP streams evaluate the
response-aware policy before opening the file, preserving cached data and
timestamps for skipped saves and 304s. A successful direct worker publication
also releases its allocation in the same parent request, avoiding a separate
release round trip. Failed direct output is not deleted during cleanup.

Normalization is no longer implicit at queue admission, in custom factories,
or between lifecycle hooks. Callers submit a valid `Resource`; hooks maintain
its URL/URI fields or explicitly call `normalizeResource` after mutation or
structured cloning. Worker receipt still decodes and normalizes wire resources.

Task, result, control, log and publication messages no longer send or check a
version. The old version constant and optional type fields remain deprecated
compatibility exports. Workers and the parent must use the same installed runtime.

## Repeated measurements

Serial Node 24.18.0 runs, discarded warm-ups, alternating variant order and
explicit GC. Timings include initialization and disposal. Synthetic output
hashes, file/request counts and MDN output hashes match across variants.
Raw samples and source fingerprints are in
[the evidence file](evidence/performance-defaults.json).
Artifacts are under `artifacts/wse-relaxed-checks-20261001`.

Latest five-sample synthetic median milliseconds:

| Mode | Workload | 0.9.1 | New defaults | Difference |
| --- | --- | ---: | ---: | ---: |
| Single | Buffered | 70.5 | 78.5 | 11% slower |
| Single | Streamed | 97.8 | 109.8 | 12% slower |
| Single | Local | 14.3 | 16.3 | 14% slower |
| Single | Markup | 282.2 | 246.3 | 13% faster |
| Multi | Buffered | 369.3 | 386.8 | 5% slower |
| Multi | Streamed | 130.5 | 113.2 | 13% faster |
| Multi | Local | 305.0 | 310.3 | 2% slower |
| Multi | Markup | 543.8 | 611.1 | 12% slower |

An earlier seven-sample run measured single markup at 312.7 / 274.2 ms and multi
streaming at 169.0 / 148.5 ms (0.9.1 / new defaults). Buffered and multi-markup
results varied between runs. These short fixtures remain sensitive to host load;
all slower samples are retained, and no overall speedup is inferred by averaging
different workloads. The earlier run predates only the direct worker release
round-trip reduction; the final source is used in the latest run.

MDN uses the real MdnDownloader/lifecycle in a bounded replay: 12 distinct URLs,
the saved Using_images document, depth zero, concurrency eight, fixed acquisition,
no bootstrap seeding and network blocked. This is not a full live archive.
Each pair uses identical MDN source; only the engine differs.

| Probe | 0.9.1 | New defaults | Difference |
| --- | ---: | ---: | ---: |
| Seven-sample replay, original MDN cleanup | 1186.0 ms | 1106.9 ms | 7% faster |
| Seven-sample replay, current MDN cleanup | 1037.9 ms | 974.9 ms | 6% faster |
| Five-sample 3,980-link probe | 470.3 ms | 401.2 ms | 15% faster |

The second replay includes the retained MDN cleanup optimization on **both**
versions. It therefore measures the engine difference rather than attributing
MDN source changes to the engine. Remaining MDN dependencies are shared from its
workspace installation, not a fresh lockfile installation.

For 48 local files, the parent filesystem probe compared the preceding engine
with the new defaults: realpath calls fell from 152 to 3, staging allocations
from 2 to 0 and renames from 48 to 0. Lstat calls rose from 17 to 51 because
direct output checks destination-file symlinks. These are JavaScript API calls,
not OS syscall counts. The final local-file gap is about 2 ms in this run.

The queue probe (p-queue 8 / 9) measured 64.3 / 49.9 ms for immediate tasks and
24.5 / 25.5 ms for yielding tasks. The options probe completed 12,000 merges in
857.1 ms with about 39 KiB retained growth; the legacy Got probe still reproduced
1,000 retained history entries. Queue/options implementations were unchanged in
this follow-up. These microbenchmarks do not establish overall crawl speed.

## Validation

The Node 24.18.0 build passes. All 426 tests in 36 suites pass on Node 22.13.0.
Coverage includes explicit atomic failure cleanup, intentional direct partial
output, direct save-policy skips, response-dependent streaming skips, destination
symlinks, one-shot pool reuse across batches, no workers for streaming-only work,
worker boundary normalization, version-free messages, ownership and resource limits.
No dependencies were changed. Earlier eager-startup and atomic-failure tests now
select those behaviors explicitly rather than silently retaining them as defaults.
