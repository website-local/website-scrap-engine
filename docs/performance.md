# Performance for 0.10

## RAM-disk repetition after restart: 2026-10-31

The user reported a computer restart and requested another complete paired
comparison. This repeats the before/after 0.10 parser-setup cleanup using
GroveDOM 0.1.2, Node 24.18.0, the same two frozen canvas pages, eight replay
requests and concurrency 1. Twelve storage blocks alternate E/R and R/E;
each placement uses a fresh process, eight warmups per build and four balanced
ABBA/BAAB rounds. All 768 primary pipelines are exact. There is no host gating,
normalization, sample removal, replacement or extension of the fixed panel.

The RAM comparison is effectively neutral: the paired 95% slowdown upper
bounds are **0.10% for the pipeline** and **0.25% for processing**. The earlier
14.2% processing slowdown does not reproduce on RAM. Duration columns below
are arithmetic means; ratios are geometric means of twelve block ratios,
with two-sided Student-t 95% intervals on log ratios.

| Placement / measurement | Before | After | Paired ratio | 95% interval |
| --- | ---: | ---: | ---: | --- |
| RAM / complete pipeline | 134.82 ms | 134.34 ms | 0.9964 | 0.9918–1.0010 |
| RAM / processing | 120.68 ms | 120.37 ms | 0.9974 | 0.9924–1.0025 |
| RAM / main-thread CPU | 120.93 ms | 119.63 ms | 0.9893 | 0.9558–1.0240 |
| Disk / complete pipeline | 152.14 ms | 149.86 ms | 0.9977 | 0.8469–1.1754 |
| Disk / processing | 134.13 ms | 123.44 ms | 0.9456 | 0.8206–1.0895 |
| Disk / processing main-thread CPU | 106.93 ms | 112.47 ms | 1.0530 | 1.0204–1.0866 |

The disk CPU increase is **5.3% (95%: 2.0–8.7%)** and remains unresolved.
Disk elapsed intervals also remain too wide to exclude a 5% slowdown. CPU
clocks are quantized, often in 15.625 ms steps; this limits phase precision
without removing the unfavorable result. Unconditional performance clearance
remains open. No added source path or logical work count justifies a further
runtime fix.

For the after build, RAM reduces startup from 26.23 to 13.79 ms, paired 36.0%
(95%: 8.3–55.3%) less. Complete pipeline time is 9.5% (1.0–17.3%) less, while
processing is 2.5% (0.6–4.3%) less. Processing remains about 90% of pipeline
elapsed time. This is a bounded latency workload, separate from archive
throughput and from the earlier Cheerio 0.9.1/0.10 comparison.

Separate diagnostics retain 80 exact pipelines, 16 CPU profiles and four
native filesystem/V8 traces. RAM processing is 130.78 / 130.41 ms; the engine
HTML hook is 61.54 / 62.07 ms and MDN preprocessing is 24.02 / 24.06 ms.
The removed registry has only 0.255 ms of sampled processing ancestry before
cleanup. Large shared costs remain URL handling, DOM work, HTML processing
and logging. Both option/request objects remain fast, with 28 / 26 option
fields and 13 processing deoptimizations in each cell.

Disk diagnostic processing is 131.72 / 139.78 ms. Its sampled increase is
spread across idle, URL handling, DOM, stream/file work and logging; it does
not identify a causal source defect. Both builds retain seven HTML hook calls,
32 startup copies, eight synchronous log opens, 30 processing lstats and five
realpaths. Async write batching varies while logical output remains exact.

The harness's file-backed stdout capture uses synchronous writes through
log4js, SyncWriteStream and fs.writeSync: 387 calls cost 4.73 / 4.96 ms on RAM.
Other appenders are asynchronous. RAM after-build processing has 112.59 ms
covered by pending native filesystem operations and 7.08 ms of sampled idle
overlapping filesystem work. Pending duration is not time lost to I/O.
Concurrency 1 and awaited output/startup barriers still affect completion.
Inclusive hook/async spans overlap; elapsed-weighted CPU samples are not
exact per-function CPU charges.

All 852 successful pipelines, including four preflights, are exact, with zero
pipeline failures and zero filesystem retries. Every RAM child's reports,
events, logs, profiles, traces and retained output were copied and hash-checked
on disk before any next child started. The final receipt verifies 4,571 copied
files, including all eight RAM profiles and two RAM traces. The original
pre-restart panel remains separate, including its missing raw RAM artifacts.
Source/runtime and the previously qualified package are unchanged; no new
build/unit-test run is claimed. Cheerio remains default and broader adoption
qualifications remain open.

## RAM-disk first run before restart: 2026-10-31

A separate user-requested storage comparison moves the unchanged before/after
0.10 builds, Node 24.18.0, dependencies, recording, assets, logs and output onto
`/mnt/r`. Matched copies on `/mnt/e` provide a contemporaneous control. Both
volumes are exposed through WSL `drvfs`. This uses published GroveDOM 0.1.2,
two frozen canvas pages, eight recorded requests and concurrency 1. It is a
bounded offline pipeline comparison, separate from archive throughput.

Twelve independent storage blocks alternate E/R and R/E. Each placement uses
a fresh child, eight warmups per build and four balanced ABBA/BAAB rounds.
Imports, explicit pre-run GC and verification remain outside the pipeline
timer. All 768 primary pipelines match original output, events and requests.
Arithmetic means and paired geometric after/before ratios are shown below;
intervals are two-sided Student-t 95% intervals on the twelve block log ratios.

| Placement / measurement | Before | After | Paired ratio | 95% interval |
| --- | ---: | ---: | ---: | --- |
| RAM / complete pipeline | 218.5 ms | 210.2 ms | 0.966 | 0.899–1.039 |
| RAM / processing | 196.6 ms | 188.3 ms | 0.963 | 0.891–1.042 |
| RAM / main-thread CPU | 184.4 ms | 183.9 ms | 0.997 | 0.961–1.035 |
| Disk / complete pipeline | 246.3 ms | 226.8 ms | 0.915 | 0.817–1.024 |
| Disk / processing | 196.9 ms | 193.2 ms | 0.981 | 0.925–1.041 |
| Disk / main-thread CPU | 182.9 ms | 184.6 ms | 1.006 | 0.956–1.058 |

The pipeline and processing intervals meet the declared 5% slowdown margin
on both placements. The earlier 14.2% processing increase does not reproduce
here. These results support bounded review preparation; they do not establish
zero effect or explain the cause of every earlier observation. Disk CPU still
has a 5.8% upper bound, and the earlier panel remains intact and unattributed.
These measurements did not establish unconditional performance clearance.

RAM reliably reduces startup elapsed time: 49.1 to 21.7 ms for the before build
and 33.2 to 21.6 ms for the after build. The paired after-build startup change
is -30.5% (95%: -45.7% to -11.0%). Its whole-pipeline storage interval still
spans parity. Processing is about 90% of the after build's RAM elapsed time;
faster storage does not establish a processing improvement.

Two separate diagnostic storage blocks recorded 80 exact pipelines and 16
measured CPU profiles plus native filesystem/V8 traces. On RAM the engine HTML
hook is 95.70 / 95.78 ms and MDN preprocessing is 33.49 / 32.06 ms. There are
387 native synchronous writes during processing, taking 7.43 / 7.42 ms; sampled
stacks include log4js stdout through Node's synchronous file-backed stdout.
The other file appenders are asynchronous. With concurrency 1, awaited file
operations and the startup copy/index barrier can still extend elapsed time.

RAM diagnostic processing is 205.6 / 208.0 ms; disk diagnostic processing is
202.3 / 222.0 ms. These smaller instrumented observations are retained
separately and do not replace the primary estimates. Both option objects stay
fast, with 28 / 26 properties. RAM deoptimization counts are 13 / 12 and native
major-GC spans are 5.69 / 5.45 ms. No added work or repeatable source hotspot
justifies another runtime fix. Hook and asynchronous I/O spans overlap;
inclusive timings must not be added, and CPU samples are elapsed-weighted
estimates rather than exact function CPU costs.

All 852 successful pipelines, including four preflights, are exact, with no
filesystem retry. Two initial relocation preflights failed before pipeline
timing because the isolated dependency copy omitted MDN's directly imported
`cacheable-lookup`; copying the unchanged installed package completed the
runtime closure. Both failure details remain. No observations were dropped,
normalized, replaced or gated on host activity in the analysis.

The final preservation copy failed because the RAM task directory was no
longer present. The completed 852-pipeline audit, all primary per-pipeline
elapsed/main-thread timings and the derived diagnostic analyses survive on
disk. Disk raw reports, logs, eight CPU profiles and two native traces remain;
RAM's 426 report/event pairs, eight profiles, two traces and raw logs are
unavailable. The user reported a computer restart. The local handoff
records this preservation gap; it prevents rechecking those raw RAM artifacts.
No timing sample was replaced or rerun. No production code or dependency was
changed by this experiment. Cheerio remains default; sustained memory and
GroveDOM adoption stay open.

## Downstream parser setup: 2026-10-31

The application-owned parser setup removes the engine's GroveDOM module registry,
initialization and pool options. The application imports and initializes its
parser and supplies `loadHtml`; Cheerio remains the default. Only the emitted
`cheerio.js` and `options.js` differ from the preceding 0.10 working tree.
The source-tag optimization is present in both builds.

These comparisons use existing Node 24.18.0, published GroveDOM 0.1.2 and two
frozen offline MDN workloads. MDN's emitted code, supplied Cheerio, asset
copying and GroveDOM pool settings are identical. Eight independent blocks
per case use balanced ABBA/BAAB order. Warmed children run eight warmups per
build before four measured rounds; fresh-process blocks use four processes
and include entry imports and parser initialization, with natural GC only.

Milliseconds below are arithmetic means. Ratios are geometric means of the
eight independent after/before block ratios, with 95% Student-t intervals on
log ratios. Values above 1 mean slower. Complete pipeline timing includes
initialization, processing, logging, output I/O and disposal.

| Measurement | Parser / workload | Before | After | Paired ratio | 95% interval |
| --- | --- | ---: | ---: | ---: | --- |
| Warmed pipeline | GroveDOM / canvas | 250.5 ms | 280.8 ms | 1.126 | 0.995–1.276 |
| Warmed pipeline | GroveDOM / Array | 484.6 ms | 432.5 ms | 0.915 | 0.783–1.068 |
| Warmed pipeline | Cheerio / canvas | 469.0 ms | 437.8 ms | 0.950 | 0.836–1.080 |
| Warmed pipeline | Cheerio / Array | 1381.1 ms | 1402.0 ms | 1.014 | 0.968–1.062 |
| Fresh imports + pipeline | GroveDOM / canvas | 837.8 ms | 831.7 ms | 0.993 | 0.968–1.018 |
| Fresh imports + pipeline | GroveDOM / Array | 979.7 ms | 990.9 ms | 1.009 | 0.923–1.102 |
| Fresh imports + pipeline | Cheerio / canvas | 1059.3 ms | 996.3 ms | 0.942 | 0.880–1.009 |
| Fresh imports + pipeline | Cheerio / Array | 1716.1 ms | 1723.8 ms | 1.003 | 0.976–1.031 |

The warmed GroveDOM canvas processing phase shows a **14.2% slowdown**
(95% interval: 1.7–28.2% slower). Its total-pipeline Student-t interval spans
parity, while the block-bootstrap interval is 1.019–1.237. This original finding
remains unattributed. None of this panel's warmed total-pipeline intervals
excludes a 5% slowdown. Main-thread CPU point estimates change by less than 2%
in all four warmed comparisons. The later storage follow-up above supplies
separate bounded evidence without replacing these observations.

A separate four-block diagnostic uses 16 measured CPU profiles, filesystem
and lifecycle spans, native filesystem/V8 traces, and actual option layouts.
Processing is 163.2 / 162.5 ms and the engine HTML hook is 75.5 / 75.7 ms.
The diagnostic's elapsed difference is in initialization: 18.4 / 44.6 ms.
Native traces record the same 32 asset copies and eight synchronous log opens
per pipeline. Log opens take 1.5 / 8.9 ms; the CPU profiles show 4.8 / 22.5 ms
of startup idle time with pending filesystem work. Async operations overlap
and their inclusive durations cannot be added. Both options objects retain
fast V8 properties, with 28 / 26 own properties; deoptimization counts match.
These diagnostics locate I/O costs but do not explain away or replace the
earlier uninstrumented processing slowdown. No source fix is inferred from it.

Fresh GroveDOM imports take about 15 ms longer after application initialization
moves into the import interval. The import-inclusive result supplies the fair
startup comparison; a shorter pipeline alone is not a total-startup gain.

The original warmed panel preserves 793 successful pipelines and one harness
scratch-directory `mkdir` EINVAL failure before pipeline timing. A separate
canvas control removes that unnecessary replay setup and completes 256 exact
pipelines; it does not replace or pool the failed block. All 128 fresh-process
and 80 diagnostic pipelines also match original output, events and requests.
There is no host gating, sample removal, normalization or replacement. Raw
blocks, bootstrap intervals, both halves, identical-build drift and failed
output remain in the local performance handoff. Correctness qualification is
documented in the [loader guide](grovedom.md#downstream-loader-qualification-2026-10-31).

## Paired MDN 0.9.1 / 0.10 comparison: 2026-10-31

This earlier completed comparison uses Cheerio, identical final MDN asset
copying on both engine versions, the supplied loader and the native URI and
selector changes. It precedes the downstream-parser cleanup above. Its eight
balanced blocks per workload preserve 512 exact pipelines:

| Workload | 0.9.1 mean | 0.10 mean | Paired elapsed change | 95% interval |
| --- | ---: | ---: | ---: | --- |
| canvas | 534.8 ms | 462.2 ms | -14.0% | -20.2% to -7.2% |
| Array | 1678.1 ms | 1208.7 ms | -27.9% | -31.1% to -24.7% |

Main-thread CPU falls 15.1% / 28.4%. Deeper profiles show less engine selector
traversal and removal of URIjs self samples; parsing, MDN cleanup, skip logging
and publication checks remain substantial costs. The separate MDN startup fix
replaces recursive copying of 30 owned icons with enumeration and parallel
file copies inside the timer. Its incremental canvas comparison estimates
11.3% less pipeline time; the Array result spans parity. These percentages
are not combined with the engine-version comparison.

The historical 421 / 422 ms canvas result remains evidence of parity for its
older lazy-loader configuration. The initial later canvas comparison also
remains inconclusive. None of these panels is replaced or pooled with another.
The standalone static `SourceDefinition.tag` trial established no reliable
additional speedup; the hint now avoids per-document selector classification
without a separate performance claim.

These are bounded recorded workloads, not archive-throughput or sustained-
memory qualifications. Actual MDN still declares and installs engine 0.9.1.
Cheerio remains default, and GroveDOM's separate adoption requirements remain
open.

## Prefix and promise measurements: 2026-10-27

Local path containment now uses a module-cached `'..' + path.sep` prefix.
Asynchronous status observers start together and join through
`Promise.allSettled(...).then(...)`. Synchronous observers still use the shared
completed promise without a pending array. Lifetime and shutdown tracking remain
necessary; the [migration guide](../MIGRATION-0.10.0.md#status-observers) explains
the observer ordering change.

The finalizer microbenchmark used one fulfilled promise and a callback capturing
the resource. Raw medians are nanoseconds per operation:

| Runtime | `await` | `.then` | Qualified comparison triples |
| --- | ---: | ---: | ---: |
| Node 22.22.2 | 763.1 | 720.7 | 19 |
| Node 24.18.0 | 628.5 | 569.2 | 15 |

Four-promise cases showed roughly 1–3% lower raw median time with `.then`.
All six resource-capturing comparisons had at least 12 qualified triples and
95% ratio intervals below 1 against both the baseline and its identical control.
Control placement differences limit the precision of the percentage estimates.
These measure promise-barrier overhead with a synchronous finalizer. They do
not compare whole dispatchers or establish a downloader throughput gain.

Prefix-only raw medians for mostly-contained POSIX inputs, in nanoseconds:

| Runtime | Concatenation | `charAt` check | Module-cached prefix | Qualified triples, `charAt` / cached |
| --- | ---: | ---: | ---: | ---: |
| Node 22.22.2 | 16.484 | 4.229 | 5.117 | 23 / 21 |
| Node 24.18.0 | 19.003 | 6.056 | 5.345 | 1 / 1 |

The Node 24 prefix timings lack the required 12 qualified triples and remain
raw observations. The cached prefix was faster than `charAt` on Node 22's
edge-heavy inputs; neither alternative wins universally. Full containment
checks, including `path.relative`, showed much smaller and inconsistent gains.
Separate heap sampling estimated 23.0–23.5 allocated bytes per concatenation
call on both runtimes. Neither alternative had allocations sampled in its
variant code; zero samples do not prove literally zero allocation.

Each workload uses 24 fixed samples, three discarded warmups, rotating/reversed
variant order and an identical control. Qualified triples require CPU/wall >=
0.85 and fewer than one externally busy core for every compared variant.
POSIX and Windows path algorithms were measured on Linux; native Windows remains
unqualified. [Recorded plans, results and input hashes](evidence/listener-prefix-performance.json)
preserve the measurements after temporary profile and build cleanup.

## Property-access review: 2026-10-27

The [object layout review](object-layout-review.md) extends the earlier profiles
and records the current fixes, runtime layouts and rejected experiments. Direct
assignments in worker resource normalization retain the original object and keep
the measured 27-property HTTP worker resources fast on Node 22.22.2 and 24.18.0.
The earlier `Object.assign` version enters dictionary mode. Retained worker-resource
graphs use about 1.35 kB less JavaScript heap each in the controlled probe.

Option/header spread copies also simplify construction. Paired crawl measurements
establish no reliable overall speedup. Extra worker copying and hoisted wire-field
arrays were rejected; the HTML link-array allocation remains unchanged. These
results do not measure whole-crawl RSS, DOM/Wasm memory or MDN adoption performance.

## HTML link-array experiment: 2026-10-25

The quality pass compared `links = [attrValue]` with one reusable array per
`processHtmlDoc` invocation. Both variants produced identical output and
per-parent discoveries during concurrent processing, reentrant hooks, and
recursive `iframe[srcdoc]` processing. No shared array was used across calls.

Each workload/runtime used 30 paired blocks with alternating execution order.
The ratio is current elapsed time divided by reusable-array elapsed time;
values above 1 favor reuse. Intervals are 95% paired-log-ratio intervals.

| Runtime | Workload | Ratio | 95% interval |
| --- | --- | ---: | --- |
| Node 22.22.2 | Ordinary links | 0.981 | 0.922–1.043 |
| Node 22.22.2 | Mixed links | 1.027 | 0.974–1.084 |
| Node 24.18.0 | Ordinary links | 1.012 | 0.959–1.068 |
| Node 24.18.0 | Mixed links | 0.978 | 0.941–1.016 |

Every interval includes 1. Substantial outside host activity also limits
sensitivity to a small allocation effect. Keep `links = [attrValue]`: this
experiment establishes no reliable throughput improvement from reuse. It does
not measure a speedup from the ownership refactor or removal of aggregate
body-byte accounting.

## Object layout audit: 2026-10-25

The audit used actual resources, downloaders, pipelines, options, statistics,
publication records and worker instances on Node 22.22.2 and 24.18.0. V8 property
mode checks, heap snapshots and retained-object batches were measured separately
from the link-array timings. TypeScript interface fields allocate no storage
until properties are assigned to a runtime object.

The earlier quality-pass iteration added eleven Resource runtime fields; six
were removed. The five remaining fields are `workerTaskId`, `publicationOwner`,
`downloaded`, `publishedFiles`, and `discoveredCount`. They hold distinct state.
Resource retains no downloader, pipeline, child array or replacement state object.
Three redundant initialization fields were also removed from each downloader.
Their final 23/28 own properties remain fast, with warmed shallow sizes of
208/248 bytes for single/multi downloaders on both runtimes.

Main-thread Resources remain fast from creation through ordinary processing
and cleanup: 18 properties at creation and 28 after processing. Clearing `doc`
and pending status work preserves fast metadata properties. Retrying by deleting
old error metadata enters dictionary mode; worker URI normalization also enters
dictionary mode in that dated implementation. Both transitions occur in the
original baseline as well. The 2026-10-27 direct-assignment result above updates
the HTTP worker observation. No
extra object copy or Map replacement was added to change those layouts.

Six batches per runtime retained 1,800 real Resources with distinct URLs and
shared source text. After two full GCs per observation, final median retained
heap per Resource fell from about 7.33/7.34 kB while parsed to 1.28/1.26 kB after
document cleanup on Node 22/24; no documents remained attached. The older
Cheerio path retained its document in this controlled workload. Separate idle
downloader graphs were slightly larger overall after the full refactor despite
the three-field removal. Field counts alone do not establish a memory or
throughput improvement. These intentionally retained-object measurements do not
estimate crawl RSS, Wasm memory, or full-archive behavior.

## Earlier 0.10 measurements

The following results preserve measurements and decisions for their dated
revisions. They do not qualify the later explicit-ownership quality pass.

The first focused comparison of final `f057597` against 0.9.1 confirms less
elapsed time for **multi-thread buffered HTTP (-28.94%)** and **multi-thread
local files (-32.42%)**. Multi-thread markup shows no clear difference; five
synthetic controls still fail. The earlier MDN-local comparison also shows no
clear difference. Strict non-regression remains unproven.

On 2026-10-04 the user accepted these results for now and requested that further
runs stop. Benchmarking is paused; this acceptance does not change the measured
confidence intervals or convert failed controls into confirmed results.

## Second independent repeat: 2026-10-04

The same five cases were repeated again at the user's request, with unchanged
pairing, round count and filtering. [Full evidence](evidence/focused-paired-repeat2.json).
All five controls failed; the estimates below are inconclusive.

| Case | Retained / 18 | Elapsed estimate | Control 95% interval |
| --- | ---: | ---: | --- |
| Single buffered | 18 | -10.14% | +2.31% to +15.48% |
| Single streamed | 17 | -5.40% | -8.44% to +3.37% |
| Multi streamed | 18 | -41.88% | -6.29% to +3.52% |
| Single local | 18 | -0.57% | -1.31% to +7.07% |
| Single markup | 18 | -20.15% | -2.35% to +6.51% |

This campaign took **126.5 seconds including host checks/waits**. One of 90
case-round groups was excluded (single streamed HTTP); all output checks matched.
Starts passed at 0–9% CPU with empty disk queues. Post-run samples were 2%, 32%
and 2%, so host activity remained intermittent. Frozen inputs and independent
statistical verification passed. Earlier campaigns remain separate, and the
performance gate remains open; no improvement or regression qualifies here.

## Independent repeat: 2026-10-04

At the user's request, the five failed-control cases were measured again in a
separate fixed campaign. [Full repeat evidence](evidence/focused-paired-repeat.json).
All **18 rounds per case** were retained; none of 90 groups crossed the fixed
CPU/I/O thresholds. All five identical-code controls still failed the ±5% rule.
Negative estimates mean less elapsed time; none below qualifies as a confirmed
improvement or regression in this repeat.

| Case | Elapsed estimate | Paired change | Identical-code control 95% interval |
| --- | ---: | ---: | --- |
| Single buffered | -9.90% | -2.770 ms | -3.87% to +7.55% |
| Single streamed | +3.86% | +1.131 ms | -5.09% to +8.76% |
| Multi streamed | -45.63% | -26.302 ms | -3.97% to +6.44% |
| Single local | +6.96% | +0.583 ms | -4.65% to +6.85% |
| Single markup | -20.39% | -17.532 ms | -4.05% to +7.30% |

The repeat took **106.6 seconds including host checks**. Every start passed three
CPU samples at 0–9% with empty disk queues. After the run, CPU samples rose to
3%, 31% and 20%, with active Node processes. Quiet starts and passing probes did
not establish stable workload timing; the failed identical-code controls remain
decisive. Output hashes/counts/bytes and requests matched, the 32,315 original
input fingerprints were unchanged, and an independent verifier reproduced all
intervals, filtering and classifications.

Pairing, calibration, round count and thresholds were unchanged. Earlier campaigns
remain separate; no samples were pooled and no result was replaced. The five
cases remain unresolved, so this repeat does not close the final performance gate.

## Focused paired follow-up: 2026-10-04

[Results, host samples and harnesses](evidence/focused-paired-remeasurement.json).
This addresses the eight synthetic cases whose fresh-process controls failed.
Negative changes mean less elapsed time; estimates with failed controls remain
inconclusive even when their effect interval excludes zero.

| Case | Retained / 18 | Elapsed change | 95% interval | Paired change | Interpretation |
| --- | ---: | ---: | --- | ---: | --- |
| Single buffered | 18 | -6.44% | -12.24% to -1.13% | -1.527 ms | Failed control; inconclusive |
| Multi buffered | 18 | -28.94% | -30.24% to -26.75% | -103.331 ms | Confirmed improvement |
| Single streamed | 18 | +0.02% | -3.83% to +2.82% | +0.007 ms | Failed control; inconclusive |
| Multi streamed | 18 | -43.82% | -46.25% to -40.99% | -25.900 ms | Failed control; inconclusive |
| Single local | 17 | +5.95% | -0.17% to +16.81% | +0.503 ms | Failed control; inconclusive |
| Multi local | 18 | -32.42% | -33.92% to -31.27% | -107.946 ms | Confirmed improvement |
| Single markup | 17 | -18.65% | -24.70% to -14.35% | -15.804 ms | Failed control; inconclusive |
| Multi markup | 18 | +1.82% | -1.33% to +2.99% | +8.688 ms | No clear difference |

Windows initially showed 10–17% total CPU, empty disk queues and intermittent
activity from other benchmark/test processes. Each case waited for three samples
at no more than 10% CPU and disk queue length one. All starts passed, with observed
CPU between 0% and 6% and empty queues. Post-run samples were 2%, 2% and 14%:
quiet starts do not establish uninterrupted idleness. Host probing ran between
cases, outside timed observations; bracketing workload probes handled filtering.

The pass took **433.5 seconds including host checks/waits**. Each case ran in one
dedicated process, with both APIs warmed twice, three discarded calibration rounds
and exactly 18 measured rounds. Each round alternated baseline/current/control,
then reversed that order for a second observation. Six permutations repeated
three times. Every observation initialized, ran and disposed a fresh crawler,
including worker startup; candidate/control share the same imported current API.
These are warmed complete-crawl measurements, not cold-import timings.

Two of 144 complete case-round groups were excluded using fixed CPU/I/O thresholds
(1.5 times the median of three calibration group maxima). Paired 10,000-resample
bootstrap intervals and the original ±5% identical-code stability rule were
unchanged. Both candidate copies must qualify an improvement. No rounds were
added, pooled or discarded based on crawl times or favorable effects.

Output hashes, byte/file counts and request counts matched across every variant.
All 32,315 original frozen input entries matched before and after the pass; the
new harness/protocol hashes also matched. Independent Python calculations verified
host-start rules, ordering, calibration, exclusions, intervals and classifications.

The single-thread local estimate is +0.503 ms (+5.95%), with an interval crossing
zero and failed control; this does not reproduce a confirmed large slowdown.
Single markup narrowly fails its control (upper bound +5.14%); the threshold was
not relaxed. Five unresolved cases prevent closing the overall gate. These results
also do not retroactively close the earlier allocation-specific latency gate.
MDN was not rerun because its control already passed; its separate result follows.

## Final source versus 0.9.1: 2026-10-04

[Full results, harnesses and fixture](evidence/final-source-remeasurement.json).
Negative changes mean less elapsed time. These are paired medians; they need not
equal ratios or differences of the separate per-version medians.

| Case | Retained / 12 | Elapsed change | 95% interval | Paired change | Interpretation |
| --- | ---: | ---: | --- | ---: | --- |
| Single buffered | 11 | +20.68% | +7.73% to +31.47% | +5.798 ms | Failed control; inconclusive |
| Multi buffered | 12 | -33.70% | -35.96% to -25.31% | -149.465 ms | Failed control; inconclusive |
| Single streamed | 12 | +17.78% | +8.36% to +33.84% | +6.481 ms | Failed control; inconclusive |
| Multi streamed | 12 | -40.94% | -46.68% to -30.50% | -25.337 ms | Failed control; inconclusive |
| Single local | 11 | +42.52% | +21.15% to +50.77% | +3.027 ms | Failed control; inconclusive |
| Multi local | 12 | -33.96% | -39.11% to -28.80% | -135.821 ms | Failed control; inconclusive |
| Single markup | 10 | -17.34% | -36.43% to -7.70% | -19.077 ms | Failed control; inconclusive |
| Multi markup | 12 | -6.06% | -12.29% to +7.91% | -32.489 ms | Failed control; inconclusive |
| Single MDN-local | 12 | -4.93% | -7.66% to +0.36% | -19.769 ms | No clear difference |

The campaign took **421.1 seconds** on Node 22.13.0: three discarded calibration
triplets, then exactly 12 balanced rounds per suite, two observations per process
and one warmup per case. Four of 108 case-round groups were excluded by fixed
CPU/I/O probe thresholds. No timing-based exclusions, extra rounds or pooling
were used. Identical-code control intervals must contain zero and fit within
±5%; both candidate copies must independently qualify a signed effect.

All nine output/hash/count checks passed. Final source hashes and 32,315 frozen
input entries were verified; all 172 baseline emitted files match the preserved
0.9.1 fingerprints. An independent Python calculation reproduced calibration,
exclusions, balanced ordering, bootstrap intervals and classifications.

The synthetic estimates suggest faster multi-thread downloads and single-thread
markup, with about 3–6.5 ms extra in small single-thread binary crawls. Failed
controls prevent confirming those effects. MDN-local's control interval is
-2.75% to +2.73%; its elapsed estimate is -4.93%, with an effect interval of
-7.66% to +0.36%. This supports no clear difference, not a demonstrated slowdown.

The saved MDN page is 101,908 bytes but differs in hash from the deleted earlier
fixture. Its text is preserved in the evidence. The existing emitted MDN lifecycle
is held constant across engines, with imports rebound to each version. This
three-page replay excludes network and does not include the separate stylesheet
used in later optimization experiments. It cannot isolate changes from the older
MDN campaign. These measurements do not assess allocation, RSS or steady-state
throughput, and do not close the earlier allocation-specific latency gate.

## Earlier 0.9.1 comparison: 2026-10-03

The candidate is the tracked working tree based on `a1f5fb1`, including the retained
worker-result cleanup, compared with the preserved 0.9.1 emitted artifact on
Node 22.13.0. An identical copy of current code provides the control. Shared
dependencies resolve to the same physical packages; the Got 13/p-queue 8 versus
Got 16/p-queue 9 differences are intentional. Source, runtime, dependency and
harness fingerprints are recorded in the
[preserved input evidence](evidence/final-working-tree-performance.json). The fresh
[measurements and host samples](evidence/idle-working-tree-performance.json) record
the run from 08:36:29 to 08:42:35 UTC without pooling earlier samples.
This snapshot predates the HTTP-cache security mitigation described in the
[dependency audit](dependency-audit.md); these figures do not validate that change.
The [release audit](release-0.10.0-audit.md) distinguishes this tree from committed CI.

Negative changes mean less elapsed time. Percentages and milliseconds are medians
of paired differences; the intervals are 95% paired bootstrap intervals. An
interval excluding zero does not override a failed identical-code control.

| Case | Retained rounds / 12 | Elapsed change | 95% interval | Paired change | Control stable? |
| --- | ---: | ---: | ---: | ---: | --- |
| Single buffered HTTP | 12 | +8.14% | +3.51% to +25.64% | +2.192 ms | No |
| Multi buffered HTTP | 10 | -27.61% | -29.60% to -24.83% | -107.340 ms | Yes |
| Single streamed HTTP | 11 | +8.72% | +2.42% to +16.36% | +2.814 ms | No |
| Multi streamed HTTP | 11 | -38.16% | -41.09% to -31.02% | -22.040 ms | No |
| Single local binary | 11 | +29.59% | +21.58% to +42.22% | +2.130 ms | No |
| Multi local binary | 12 | -32.43% | -33.63% to -29.77% | -107.079 ms | No |
| Single markup | 11 | -9.62% | -16.27% to -5.45% | -11.443 ms | No |
| Multi markup | 12 | +1.46% | -1.07% to +3.27% | +6.752 ms | Yes |
| Single MDN replay | 12 | +0.18% | -1.05% to +2.19% | +0.568 ms | Yes |

These are complete small crawls, including initialization, admission and disposal.
They do not establish steady-state throughput. Synthetic fixtures use 12 binary
files (64 KiB buffered/local, 256 KiB streamed) or six markup documents producing
24 outputs, concurrency eight and two workers. The MDN fixture replays three saved
documents with network access disabled.

The single-local percentage corresponds to about 2.1 ms on this tiny fixture.
Lifecycle, accounting and filesystem work have a larger relative cost when the
underlying operation is short. This campaign does not isolate their individual
contributions. Earlier directory experiments counted Node filesystem API calls,
not operating-system syscalls, and did not establish a benefit from lifting more
checks.

## Noise filtering and interpretation

The host initially showed 15–23% CPU use despite a low WSL load average; Windows
process counters identified background Rust compilation. The run started after
three consecutive Windows samples of 1%, 9% and 6% CPU with empty disk queues.
A later post-run sample was 5% CPU with no queued disk I/O. These observations
establish a quiet starting window, not uninterrupted idleness throughout the run.
The workload probes and identical-code controls remain necessary.

This fresh revision-2 campaign took 365.7 seconds, including calibration and
verification:

- Three discarded calibration triplets per suite used 18 fresh processes. Each
  case had 12 bracketing CPU/I/O probes per group, in the real workload context.
  Each metric threshold was frozen at 1.5 times the median of three calibration
  group maxima. This short heuristic has no guaranteed false-positive rate.
- Twelve balanced measured rounds per suite used 72 processes, each with one
  discarded warmup and two observations per case. Process medians were paired
  by round, with 10,000 deterministic bootstrap resamples (seed 123456789).
- A threshold violation removed the entire triplet for that case. Six of
  108 groups were excluded, all for I/O probes. Each case retained 10–12 rounds;
  the raw evidence records every excluded case and round. All functional checks and output hashes passed.
- At least eight rounds were required. The control interval had to include zero
  and fit entirely within ±5%. Faster/slower classification also required both
  current copies versus legacy to have intervals on the same side of zero.

All cases retained enough rounds. Multi buffered HTTP passed control stability
and both current copies were faster than legacy: current's paired change was
-27.61% (95% interval -29.60% to -24.83%). Multi markup and MDN passed control
stability with unresolved effect intervals. Six cases failed the control check,
so their apparent gains or regressions remain provisional. Passing the probe
filter alone does not establish stable workload timing.

The earlier revision-2 campaign retained 11–12 rounds with two exclusions and
only one passing control. Its evidence remains unchanged. The present campaign
has three passing controls; it still does not resolve every comparison.

The separate revision-1 campaign rejected 87/108 groups using idle calibration
and a mismatched group filter. That rejection rate did not demonstrate a more
loaded host. Revision 2 calibrated the same workload context and group statistic
used during measurement; it did not relax the control criterion. Campaigns were
not pooled. Older Node 24.18 results and focused microbenchmarks also describe
different artifacts or workloads: their percentage gains must not be added to
this table.

## Allocation follow-up: 2026-10-03

Retained in `8c7a290`, against `584e07c` plus the inherited worker cleanup:
remove unnecessary awaits, synchronous hook closures and CSS regex captures.
Sampled cumulative allocation fell 21–24% for CSS, about 17% for SVG and
15–23% for combined resource creation across normal/pressure modes. All timing
comparisons lacked enough rounds or failed controls; the quiet-host latency gate
remains open. The candidate passed 531 tests, builds, 15,000 CSS comparisons and
eight crawl-output comparisons. [Evidence](evidence/performance-memory-followup.json).

## CSS scanner and local MDN replay

The CSS scanner was rejected; the trimmed regex remains. Both prototypes matched
51,312 inputs, but the tuned scanner added complexity and only reduced full MDN
sampled allocation by about 1%. All timing controls failed or had too few rounds.
Duplicate-heavy CSS allocation gains do not establish a general benefit.
[Evidence](evidence/css-scanner-mdn.json).

The local MDN workload replays three saved 101,908-byte HTML pages and an extracted
inline stylesheet with network access disabled, concurrency eight and depth zero.
It includes initialization, local acquisition, processing, output and disposal:
four matching files totaling 323,010 bytes. It is a small single-thread replay,
not a full mirror or a representative external stylesheet corpus.

## Markup and path follow-up: 2026-10-04

Retained as `2382067`, against `8c7a290` plus worker cleanup: reuse split path
segments and avoid rewriting unchanged inline styles, while preserving hook
mutations. MDN elapsed time fell **6.11% normally** (95% interval -7.39% to -4.64%)
and **4.66% under pressure** (-6.74% to -0.83%), passing both-copy controls.
Normal link creation qualified as 1.52% faster. Other focused comparisons remain
partly unresolved, including possible pressure CSS regression; these results do
not retroactively close the earlier allocation gate.

Validation: 534 tests, builds, eight crawl-output comparisons, 80,000 resource/path
outcomes per experiment, then 160,000 POSIX/Windows-path and 8,000 HTML/CSS fuzz
cases. [Measurements](evidence/markup-path-followup.json),
[fuzz evidence](evidence/markup-path-fuzz.json).

## Redirect path reuse follow-up: 2026-10-04

Retained as `b260204`: reuse the relative-path helper when saving redirects.
Sampled path allocation fell; no saving-stage speedup was established.
Validation: 534 tests, builds and 100,000 path equivalence checks.
The inline-CSS marker prototype added allocation without a clear MDN benefit
and was excluded. [Evidence](evidence/redirect-reuse-investigation.json).

## Status and query follow-up: 2026-10-04

Retained as `2789de6`, against `b260204` plus worker cleanup: reuse synchronous
status completion, track pending notifications and reduce query-processing
arrays/conversions. Promise, listener ordering/context, disposal and filenames
remain compatible.

| Sampled cumulative allocation | Normal | Managed heap pressure |
| --- | ---: | ---: |
| Synchronous status notifications | -87.79% | -36.82% |
| Asynchronous status notifications | -27.33% | -18.33% |
| Short-query resource creation | -4.76% | -4.16% |
| Long-query resource creation | -21.95% | -15.07% |
| Local MDN replay | -4.62% | -2.52% |

Normal long-query creation qualified as **20.99% faster** (95% interval -24.92%
to -17.49%; 12/12 rounds). The other nine controls failed, including both MDN
modes. Status fixtures exclude resource creation. Validation: 548 tests, builds,
14 compatibility tests also passing on baseline, 80,000 query inputs, 80,000
hashes, 800 listener sequences, 3,000 metadata cases and eight matching crawls.
Empty-metadata cloning prototypes were excluded. [Evidence](evidence/status-query-followup.json).

## Path punctuation investigation: 2026-10-04

All three candidates after `2789de6` were **rejected**. The final candidate reduced
sampled allocation around 31–32% for punctuation/short-query paths normally and
23–25% under pressure. Short-query pressure timing qualified as 28.91% faster
(95% interval -32.51% to -25.72%). Recurring long-query estimates of +5.20% normally
and +4.15% under pressure had failed controls: unresolved regression concerns,
not proven regressions. Neither ordinary paths nor MDN qualified a benefit.

Each candidate passed 550 tests, builds, 325,832 path comparisons in both URIjs
encoding modes and eight crawl-output comparisons. The two extra tests belong
to the experiments; shipping code has 548 tests. Including `~` changed ISO-8859-1
encoding, and removing later hook awaits changed cancellation boundaries; both
were rejected. [All campaigns and sources](evidence/path-punctuation-investigation.json).

Allocation follow-ups use three rotated baseline/candidate/identical-candidate
triplets per mode on Node 22.13.0, 4 KiB inspector sampling including collected
objects, a 128 MiB old-space limit and 4 MiB semi-space. Pressure includes shared
array churn retaining up to 2 MiB. These descriptive samples establish neither
exact allocated bytes nor reduced RSS, peak or retained heap. Short repeated
post-GC checks found no additional sustained growth. Campaigns remain separate;
failed controls are never overridden by favorable effect intervals.

## Retained changes and defaults

Got remains the default transport. Native HTTP is opt-in with fallback for
unsupported options. Direct writes, cached per-crawl directory preparation and
lazy workers are the defaults; atomic writes, repeated output checks and waiting
for worker startup remain explicit options. See the
[README](../README.md#performance-defaults) and
[migration guide](../MIGRATION-0.10.0.md) for configuration and contracts.

| Area | Retained change | Supporting history |
| --- | --- | --- |
| Request options and bodies | Public Got option snapshots avoid merge-history growth; Buffer views preserve the body contract | [Single-thread fixes](archive/0.10.0-experiments.md#single-thread-performance-fixes) |
| Pipeline and admission | URI reuse, synchronous hook handling and adjacent body-size reuse preserve mutable resource boundaries | [Body accounting](archive/0.10.0-experiments.md#body-accounting), [admission](archive/0.10.0-experiments.md#admission-overall-performance) |
| Workers and publication | Lazy startup, simpler publication completion, direct connection lookup and dispatch batching | [Publication](archive/0.10.0-experiments.md#publication-simplification), [completion](archive/0.10.0-experiments.md#worker-completion), [dispatch](archive/0.10.0-experiments.md#css-worker-dispatch) |
| Small cleanups | Reused composed cancellation signals and shared retry logging; validated worker-result dead branch removed in the current tree | [Simplifications](archive/0.10.0-experiments.md#minor-simplifications), [release audit](release-0.10.0-audit.md) |
| Correctness | Positive eligible retry delays, bounded stale-date handling, refreshed index-file metadata and CSS replacement offsets | [Accepted fixes](release-0.10.0-audit.md#accepted-correctness-fixes), [CSS offsets](archive/0.10.0-experiments.md#css-worker-dispatch) |

The focused dispatch-pool gain of about 44% is not a whole-crawl claim. Retry and
metadata fixes were accepted for correctness despite inconclusive strict
non-regression evidence; that decision remains separate from benchmark status.

## Rejected or deferred experiments

Further directory-check removal and ancestor reuse did not show a reliable crawl
benefit. A combined last-modified-helper experiment did not justify retention.
The range split/includes rewrite was about 28% slower for short headers under
managed heap pressure and showed no longer-list gain; it also added an allocation
for empty input. These experiments are preserved in the
[directory](archive/0.10.0-experiments.md#directory-check-reduction) and
[code-simplification](archive/0.10.0-experiments.md#code-simplification) histories.

Got rollback and automatic native-stream selection did not show a universal
benefit. Some earlier dependency profiles were confounded by physical versus
symlinked package layouts. Parser replacement and queue rewrites remain deferred;
the [dependency audit](dependency-audit.md) records the decisions. No further
speculative optimization is required for the release quality pass. Preserve
ownership, cancellation, accounting and public mutable-resource contracts.
