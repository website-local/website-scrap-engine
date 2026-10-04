# Performance for 0.10

The latest working-tree comparison with 0.9.1 establishes **27.6% less elapsed
time for multi-thread buffered HTTP** under the declared paired-control rule.
Multi-thread markup and saved MDN replay pass control stability but show no clear
difference. Six other comparisons remain provisional because their controls fail.
There is no demonstrated universal speedup or strict non-regression guarantee.

A later [allocation investigation](#allocation-follow-up-2026-10-03) against
`584e07c` reduced sampled allocation in CSS, SVG and link creation. Its timing
controls failed on the loaded host, so it does not establish a speedup or close
the candidate's latency gate.

The [markup/path follow-up](#markup-and-path-follow-up-2026-10-04) qualifies a
6.11% elapsed-time reduction in local MDN replay normally and 4.66% under heap
pressure, against `8c7a290`. Other comparisons remain partly unresolved.

## Latest 0.9.1 comparison: 2026-10-03

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

This comparison uses the tracked working tree based on `584e07c`, including the
HTTP-cache mitigation and inherited worker-result cleanup, as its baseline.
It is separate from the earlier 0.9.1 comparison. Cheerio, URIjs, dependencies,
output checks and resource accounting are unchanged. The candidate was measured before commit; source/build hashes, harnesses and
measurements are recorded in the
[follow-up evidence](evidence/performance-memory-followup.json).

Three changes remain in the candidate: avoid unnecessary awaits for synchronous
stages in combined resource creation and SVG processing, remove the per-call
recursive closure from synchronous hook execution, and remove unused CSS regex
captures and the temporary capture-selection object. Resource creation still
returns a Promise; asynchronous hooks, validation, ordering, cancellation and
discarded links retain regression coverage.

The table reports median paired changes in **sampled cumulative allocation**.
These are neither retained-memory savings nor whole-crawl percentages.

| Focused workload | Normal | Managed heap pressure |
| --- | ---: | ---: |
| CSS: 512 unique URLs/document | -21.47% | -19.88% |
| CSS: 2,048 occurrences, eight distinct URLs/document | -23.75% | -21.98% |
| SVG: 512 image links/document | -16.86% | -16.80% |
| HTML: 512 image links/document | -3.31% | -3.43% |
| Combined creation: 1,024 resources/batch | -22.64% | -15.49% |

Allocation sampling used three rotated baseline/candidate/identical-candidate
triplets in each mode, four documents or batches per observation, Node 22.13.0,
a 128 MiB old-space limit and 4 MiB semi-space. Inspector sampling at 4 KiB included
objects collected by minor and major GC. Pressure used JavaScript arrays, retaining
up to 2 MiB during work and releasing them before post-GC checks. The pipeline ran
in its real crawl context with Cheerio and URIjs. Output and discovered-link hashes
matched throughout. Three triplets support this allocation observation; they do
not establish a formal confidence bound. Profiles show fewer allocations in
Promise-related paths and regex matching, consistent with the changes.

Timing used separate short observations, three discarded calibration triplets,
the same CPU/I/O group filtering and ±5% identical-code control requirement as
above. Fresh-process campaigns ran 12 rounds per mode, requiring eight retained;
tighter interleaved campaigns ran 18, requiring 12. The normal fresh-process run
retained 8–10 rounds per case; pressure retained six for unique CSS and 11 for
the others. Interleaving retained 9–15 normally and 14–18 under pressure. Every
case either lacked enough rounds or failed control stability. No speedup,
slowdown or strict non-regression conclusion passed. Campaigns were not pooled;
favorable effect intervals do not override failed controls. Analysis and profiling
continued under host load instead of waiting for idle time.

Ten repeated mixed batches showed no sustained post-GC heap growth: baseline and
both candidate copies settled around 13.3 MiB normally and 12.0 MiB under pressure.
RSS varied by several MiB between identical candidate runs. Boundary-sampled heap
peaks also did not establish a reduction; some SVG diagnostics were higher. There
is no demonstrated RSS or peak-memory improvement. Lower cumulative allocation
does not imply lower retained heap, a lower peak, or less elapsed time.

The exact candidate passed **531 tests / 42 suites**, lint, strict source/test
types and build. A generated 15,000-input CSS corpus matched the baseline. Eight
small crawl cases (four workloads in both downloader modes) matched saved-file
counts, bytes, request counts and hashes; their one-observation timings are only
functional diagnostics. Quiet-host paired latency validation remains a release
gate for this candidate.

Two experiments were left out: combining CSS bookkeeping collections produced
negligible allocation change, and a simple-path prefix shortcut gave small,
inconsistent benefits. Both added complexity without sufficient evidence. Further
work should follow measured hotspots; this phase does not justify weakening
checks or replacing dependencies before release.

## CSS scanner and local MDN replay

Commit `8c7a290` contains the allocation changes above. The next experiment used
that code plus the inherited worker cleanup as its baseline, with Cheerio and
URIjs unchanged. **Keep the trimmed regex for the release.** A specialized scanner
is worth further investigation for CSS with many duplicate URLs, but this
prototype does not yet justify replacing the current extractor. The
[scanner and MDN evidence](evidence/css-scanner-mdn.json) preserves both prototypes,
fixtures, measurements and independent statistical checks. Production code was
not changed by this experiment.

The first prototype scanned characters individually. The tuned version uses
cached native string searches to jump to possible `url`, `@import` and comment
starts, then extracts URL tokens and offsets with a small state machine. Irregular
tokens fall back to the existing regex for the whole input. It is not a full CSS
parser and does not build an AST. Both versions matched the current extractor on
51,312 generated/fixture cases, including all 16 saved MDN style blocks. This
corpus is evidence of compatibility, not a proof for every possible CSS input.

The table shows median paired changes in sampled cumulative allocation for the
tuned scanner. Each mode used three rotated baseline/candidate/identical-candidate
triplets on Node 22.13.0, with 4 KiB allocation sampling, a 128 MiB old-space limit
and 4 MiB semi-space. Pressure totals include the same JavaScript-array churn
in every variant; no pressure baseline was subtracted.

| Workload | Normal | Managed heap pressure |
| --- | ---: | ---: |
| Extract 512 unique CSS URLs/document | -64.3% | -23.1% |
| Extract 2,048 occurrences of eight CSS URLs/document | -61.3% | -43.3% |
| Extract 512 CSS URLs/document interspersed with comments | -85.2% | -49.6% |
| Full CSS processing, 512 unique URLs/document | -2.77% | -1.76% |
| Full CSS processing, 2,048 occurrences of eight URLs/document | -53.10% | -40.01% |
| Complete local MDN replay | -1.10% | -1.05% |

The standalone MDN stylesheet extractor allocated about 44% more normally,
roughly 75 KiB over 128 repetitions of a 22.6 KiB stylesheet with four URL matches.
This small absolute increase and the full-pipeline results show why extraction
benchmarks alone should not decide adoption. No RSS, retained-heap or peak-memory
improvement was established for the scanner.

The MDN workload uses the real MDN lifecycle and URL hooks: three saved 101,908-byte
HTML documents plus CSS extracted from their inline styles, concurrency eight,
depth zero, local acquisition, real output writes and disposal. All variants
produced the same four files, 323,010 bytes and output hash. Network access was
disabled. This is a small single-thread CPU/I/O replay, not a full MDN mirror; the
CSS fixture is not MDN's external global stylesheet.

Timing ran 12 measured rounds per mode after three calibration triplets, with
two observations per variant, whole-triplet CPU/I/O exclusions and the existing
±5% control criterion. MDN retained 11/12 rounds normally and 12/12 under pressure;
both controls failed. Every extractor comparison also failed its control or lacked
eight qualifying rounds. Apparent gains after the native-search refinement remain
provisional. No timing results were pooled, and profiling continued under host
load without waiting for idle time.

The scanner's duplicate-heavy CSS savings are substantial, but ordinary unique-URL
processing and this MDN replay show much smaller allocation changes. The prototype
also adds 102 lines alongside the 60-line regex fallback. Before adoption, require
representative external stylesheets and a passing complete-workload timing gate.
The local MDN replay is now an explicit workload for the next quiet-host latency
pass on the committed allocation changes, alongside the existing synthetic crawls.

## Markup and path follow-up: 2026-10-04

The next candidate, based on `8c7a290` plus the inherited worker cleanup, retains
two changes: reuse the split path array while escaping segments, and avoid
reconstructing unchanged inline style contents. The latter rereads the element
before skipping its setter, preserving the existing result when CSS hooks mutate
the document. Dot-segment sanitization, Cheerio, URIjs and the CSS regex remain
unchanged. The candidate was measured before commit.
[Source fingerprints, measurements and validation](evidence/markup-path-followup.json)
identify the exact experiment; this is not a comparison against 0.9.1.

The complete local MDN replay passes the paired-control rule in both modes:

| Mode | Accepted rounds / 12 | Elapsed change | 95% paired interval | Median paired change | Sampled allocation change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normal | 12 | -6.11% | -7.39% to -4.64% | -20.52 ms | -5.69% |
| Managed heap pressure | 11 | -4.66% | -6.74% to -0.83% | -16.24 ms | -5.48% |

Both identical-candidate control intervals include zero and fit within ±5%, and
both candidate copies have negative effect intervals. One pressure triplet was
excluded for its I/O probe. The replay uses the same three saved MDN pages plus
one extracted stylesheet described above, with matching four-file output hashes.
These are warmed, same-process paired crawl observations, including crawler
initialization, output writes and disposal; they do not establish network or
steady-state throughput. Allocation profiles ran separately in three rotated
triplets per mode, with the same 4 KiB sampling and constrained heap settings.

Isolating the path change reduced sampled allocation by 4.02% for unique-URL CSS,
3.53% for HTML image links, 4.04% for SVG links and 5.23% for combined link creation
normally. Under pressure the respective changes were 4.07%, 3.15%, 2.93% and 0.31%.
The simpler experiment that removed only the filter array gave small, inconsistent
changes and was superseded by reusing the split array for the transformation.

The separate 18-round focused timing campaigns qualified normal link creation as
1.52% faster. Normal unique CSS, SVG and HTML passed controls without qualifying
a difference under the two-copy rule; duplicate CSS failed its control. All five
pressure-focused controls failed. In particular, an apparent pressure CSS slowdown
remains unresolved; the MDN result does not override that uncertainty. There is
still no universal speedup or strict non-regression guarantee, and these results
do not retroactively validate the earlier allocation commit against its baseline.

Ten repeated MDN crawls in separate baseline/candidate/control processes per mode
ended near 21 MiB of post-GC heap, with comparable late drift. No additional
retained-heap growth relative to baseline was observed in this short check.
RSS differences varied by mode; no general RSS or peak-memory reduction is claimed.

The exact candidate passed **534 tests / 42 suites**, lint, strict source/test
types and build. Differential checks matched 80,000 resource/path outcomes per
experiment, including malformed-input failures, plus 14 HTML cases with hook
mutations. All eight small synthetic crawl output comparisons also matched.
The independent audit reproduced calibration thresholds, exclusions, output
checks and bootstrap intervals. Additional [pre-commit fuzzing](evidence/markup-path-fuzz.json)
matched 160,000 POSIX/Windows-path comparisons and 8,000 HTML/CSS cases across
eight seeds, including asynchronous hooks and document mutation. Windows path
API coverage does not substitute for native Windows filesystem testing. CI and
final-package validation remain separate.

## Redirect path reuse follow-up: 2026-10-04

After fuzzing and committing `2382067`, a further candidate reuses `replacementUri`
when saving a redirect with an existing `redirectedSavePath`. It removes duplicate
URIjs setup while keeping the helper's fallback for unusual paths. This change is
retained. [Evidence and experiment sources](evidence/redirect-reuse-investigation.json)
include 100,000 equivalent path pairs, with 25,030 matching malformed-input errors,
and the exact retained subset's 534 passing tests / 42 suites, lint, types and build.

Across three rotated triplets, isolated calculation of 4,096 ordinary relative
paths used 70.42% fewer sampled allocation bytes normally and 40.30% fewer under
managed heap pressure. These are path-calculation figures, not crawl savings.
Redirect saving profiles were smaller and variable: four-batch confirmation
profiles showed -6.43% normally and -0.56% under pressure. Each batch saved 12
supplied HTML documents and 12 redirect stubs. Timing controls failed, so no new
saving-stage speedup is established. Ten repeated batches ended near 9.6–9.7 MiB
of post-GC heap with similar small growth across versions; RSS differences reversed
under pressure, so there is no general retained-memory or RSS improvement claim.

A separate inline-CSS marker precheck was rejected. It reduced sampled allocation
about 20% for 256 URL-free style blocks, but showed no clear MDN benefit and about
2.8% more allocation for URL-bearing styles normally. Its 8,000 HTML/CSS fuzz cases
matched, but that was insufficient reason to add the extra scan. MDN timings for
the exploratory pair of changes passed controls without qualifying a difference;
they do not establish a gain for the retained redirect-only subset.

## Status and query follow-up: 2026-10-04

The redirect cleanup is committed as `b260204`. The next candidate, based on that
commit plus the inherited worker cleanup, retains two changes: reuse completion
for synchronous status listeners and track only pending notifications; reduce
temporary arrays and string conversions when ordering and hashing URL searches.
`notifyStatusChange` still returns a Promise, listeners keep their original `this`
value and ordering, and disposal waits for asynchronous listeners. Query ordering,
duplicate values and generated filenames remain compatible. These changes are
accepted and retained. [Evidence and experiment sources](evidence/status-query-followup.json)
identify the exact source and separate final measurement campaign.

The final candidate's median paired changes in sampled cumulative allocation are:

| Workload | Normal | Managed heap pressure |
| --- | ---: | ---: |
| Synchronous status notifications | -87.79% | -36.82% |
| Asynchronous status notifications | -27.33% | -18.33% |
| Resource creation with short queries | -4.76% | -4.16% |
| Resource creation with long queries | -21.95% | -15.07% |
| Complete local MDN replay | -4.62% | -2.52% |

Status fixtures isolate depth-limit rejection of prebuilt resources, including
crawler initialization and disposal, with two listeners per resource. Query
fixtures use the full link pipeline with `deduplicateStripSearch: false`.
Profiles repeat four batches: 8,192 synchronous notifications, 1,024 asynchronous
notifications, or 2,048 resource creations. MDN uses the same three saved HTML
pages and extracted stylesheet described above, including acquisition, processing,
output writes and disposal. Every output check matched.

Each allocation result uses three rotated baseline/candidate/identical-candidate
triplets on Node 22.13.0, 4 KiB inspector sampling including collected objects,
a 128 MiB old-space limit and 4 MiB semi-space. Pressure retains up to 2 MiB of
JavaScript arrays; totals include the identical harness churn. These are sampled
cumulative allocations, not exact byte counts, confidence bounds or crawl-wide
memory savings. In particular, the status percentages exclude resource creation.

Normal long-query resource creation is **20.99% faster**, with a 95% paired interval
of **-24.92% to -17.49%** and 12/12 qualifying rounds. Its control interval contains
zero and fits within the fixed +/-5% limit, and both candidate copies qualify.
The other nine workload/mode comparisons fail their controls, including both MDN
modes. Their observed improvements remain provisional. Each case retained 10–12
of 12 rounds under the fixed CPU/I/O filter; no rounds were added or pooled.
This does not establish a general speedup or complete the release latency gate.

The exact final source passed **548 tests / 44 suites**, lint, strict source/test
types and build in an isolated tracked-source snapshot. All 14 added compatibility
tests also pass on the baseline. Differential checks matched 80,000 query inputs
(36,798 outputs and 43,202 matching failures), 80,000 hashes, 800 mixed listener
sequences and 3,000 metadata cases. Four small crawl workloads matched file and
request counts, bytes and hashes in both downloader modes (eight cases); startup, cancellation,
draining and crawl-isolation checks passed. The final review added a regression
test for standalone listener calls; the earlier prototype failed it. The corrected
source was rebuilt and measured in a separate campaign, superseding its timings.

Ten repeated batches per workload, variant and memory mode check post-GC retention
separately from timing. No additional sustained heap growth relative to baseline
was observed in this short check. RSS varies across identical runs, and no general
retained-heap, RSS or peak-memory reduction is claimed.

Two empty-metadata cloning prototypes were left out. They reduced allocations
for empty worker messages, but the effect varied more across profiles and their
extra metadata test also affects populated messages. They did not establish a
whole-worker speedup. Cheerio, URIjs, the CSS extractor and dependencies remain
unchanged by this phase.

## Path punctuation investigation: 2026-10-04

The status/query changes are committed as `2789de6`. The next investigation
**retains no new runtime changes**: extending the relative-path shortcut reduced
allocation for punctuation and short-query filenames, but repeated long-query
timing concerns did not justify accepting the tradeoff. The
[evidence and experiment sources](evidence/path-punctuation-investigation.json)
preserve all three measured implementations, their raw observations and failed
controls. Repository source and tests remain unchanged by this investigation.

The final prototype keeps the original ordinary-path condition and calculation
inline, then tries a shared matcher for `$`, `&`, `+`, comma, semicolon, `=` and
`@` after a miss. Earlier versions widened the original matcher or moved both
matchers into a helper. Each implementation was measured in a separate frozen
campaign; results were neither pooled nor repeated to obtain passing controls.

The final prototype's median paired changes in sampled cumulative allocation are:

| Workload | Normal | Managed heap pressure |
| --- | ---: | ---: |
| Ordinary relative links | +1.81% | +2.52% |
| Punctuation-bearing relative links | -32.33% | -22.93% |
| Paths retaining the URIjs fallback | -0.30% | +1.30% |
| Resource creation with short queries | -30.81% | -24.60% |
| Resource creation with long queries | -1.32% | +1.22% |
| Complete local MDN replay | +0.41% | -0.15% |

Profiles use three rotated baseline/candidate/identical-candidate triplets per
mode, Node 22.13.0, a 128 MiB old-space limit, 4 MiB semi-space and 4 KiB inspector
sampling including collected objects. Engine profiles create 2,048 resources
through the full link pipeline. Pressure retains up to 2 MiB of JavaScript arrays,
whose allocation is included in totals. MDN uses the same three saved HTML pages
and extracted stylesheet, with local acquisition, processing, output and disposal.
These are descriptive sampled-allocation changes, not retained-memory savings.

Short-query creation under pressure is **28.91% faster**, with a 95% paired
interval of **-32.51% to -25.72%**. Its control interval is **-4.18% to +3.55%**,
and both candidate copies qualify. The other eleven comparisons comprise eight
failed controls and three cases without a qualified difference, including both
MDN modes. All final comparisons retained 12/12 rounds under the existing filter.

Long-query timing estimates remain **+5.20% normally** and **+4.15% under pressure**.
Both long-query controls fail, so these are unresolved regression concerns.
Earlier implementations also produced positive long-query estimates. The final
change was rejected because that concern recurred while ordinary links and MDN
showed no qualified benefit. No confirmed general speedup or non-regression
sign-off follows from the short-query result.

All three candidate snapshots passed **550 tests / 44 suites**, lint, strict
source/test types and build. Each matched 325,832 path comparisons across eight
seeds and both URIjs encoding modes, including 11,713 matching failures; two
added encoding-compatibility tests also passed on the unchanged baseline.
Each candidate matched eight synthetic crawl-output comparisons in single and
multi modes, including HTML, CSS and SVG links containing punctuation. Startup,
save-path hooks, cancellation, draining and crawl-isolation checks passed.
The additional tests remain in the experiment snapshots. Validation ran on Linux;
Windows-style path comparisons do not establish native Windows performance.

Ten repeated batches per workload, variant and mode yielded late post-GC heap
medians near 12.8–12.9 MiB for focused cases and 21 MiB for MDN, with comparable
late growth across versions. No retained-heap, RSS or peak-memory reduction was
established. Independent checks reproduced frozen-input hashes, output checks,
calibration, exclusions, ordering and bootstrap intervals for all three campaigns.

Two earlier correctness failures were also resolved as rejected experiments.
Including `~` in the shortcut bypassed URIjs's `%7E` encoding in ISO-8859-1 mode;
all measured versions exclude it. Removing awaits from later hook stages changed
cancellation at existing microtask boundaries and was rejected before timing.

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
