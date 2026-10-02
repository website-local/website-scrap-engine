# Shared body-size validation and accounting

The subsequent [admission and overall comparison](admission-overall-performance.md)
extends size reuse to queue admission and directly measures current code against
0.9.1 with the same noise exclusion rule.

Adjacent resource-limit validation and buffer accounting now calculate the body
size once, at entry and after each hook in `download`, `processAfterDownload` and
`saveToDisk`. Resource validation still precedes buffer reservation, including
when both limits would fail. Each hook boundary recalculates the size using the
current body and encoding; nothing is cached across hooks. Unlimited crawls
without a buffer account still skip size calculation.

Conditional accounting waits, cancellation points and hook short-circuiting are
unchanged. The separate validation before the asynchronous save-policy check
remains. Existing helper signatures and configuration are unchanged.

Build and all **490 tests in 40 suites** passed. Seventeen new cases cover error
precedence, asynchronous accounting completion/rejection, changes to bodies and
encodings on the same resource, exact limits, high-water reservations, and
undefined/empty bodies.

## Measurement setup

The baseline is `a7c2b23`. Baseline, identical-baseline control and candidate use
the same dependencies and Node 24.18.0. Tests and benchmarks ran serially.
Focused and synthetic comparisons each use six balanced rounds, with a fresh
process per variant per round. Rotating/reversing order puts each variant in
each position twice. One warm-up per case is discarded; each process contributes
the median of three focused or two synthetic observations.

Independent four-million-iteration CPU probes bracket timed work. Five probe
warm-ups and nine calibration observations fix a threshold of 1.5 times the
calibration median before comparisons start. A probe above that threshold
excludes the entire three-variant group for its case. At least four qualifying
groups are required for a timing comparison. No filtering depends on whether
the candidate wins. [Portable evidence](evidence/body-accounting.json) retains
all measurements, thresholds and exclusions; earlier experiments are not pooled.

## Focused pipeline results

The actual `processAfterDownload` pipeline handles a reused 256 KiB body through
five identity hooks, with a real crawl context and, where enabled, a real buffer
budget. Each resource gets its own reservation, released after processing.
Binary resource type avoids HTML parsing. UTF-8 input repeats an emoji; the
binary comparison contains the same encoded bytes. Resource creation and body
construction happen outside timing. Returned body identity, budget peak and
released credits are checked outside timing.

| Case | Resources per observation | Baseline ms | Control ms | Candidate ms | Candidate change | Qualifying groups |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| UTF-8, both limits | 128 | 249.538 | 246.313 | 126.221 | -49.4% | 6/6 |
| Binary, both limits | 1,024 | 2.401 | 2.331 | 2.619 | +9.1% | 6/6 |
| UTF-8, resource limit only | 128 | 124.100 | 120.904 | 126.706 | +2.1% | 6/6 |
| UTF-8, buffer limit only | 128 | 120.716 | 127.541 | 122.375 | +1.4% | 5/6 |
| UTF-8, neither limit | 1,024 | 1.772 | 1.771 | 1.685 | -4.9% | 6/6 |

With both limits enabled, UTF-8 processing takes **49% less time** in this
focused workload. Its median paired change is -49.8%; the identical-code control
changes -1.3%. A separate untimed diagnostic confirms 12 string-size scans per
resource become 6: one at entry and one after each of five hooks. Single-limit
cases retain six scans, and binary/unlimited cases make no string-size scans.

The original binary observations last only 2–3 ms, with a 0.218 ms difference
per 1,024 resources. A separate binary-only follow-up increased the batch to
8,192 resources, retaining six balanced rounds, three observations and the same
noise rule. All six groups qualified:

| Follow-up | Baseline ms | Control ms | Candidate ms | Candidate change |
| --- | ---: | ---: | ---: | ---: |
| Binary, both limits, 8,192 resources | 16.757 | 18.236 | 15.124 | -9.7% |

The apparent binary slowdown did not persist in this longer isolated check.
Its control varies +8.8%, and its warming history differs from the mixed suite.
Both runs are retained separately; they establish neither a consistent binary
speedup nor exact equivalence. No runtime changes followed these measurements.

## Small crawl comparisons

Synthetic cases use six markup documents or twelve binary inputs, 64 KiB
buffered/local bodies and 256 KiB streamed bodies, concurrency eight and two
workers. The harness is derived from `scripts/benchmark-crawl.mjs`. These use
default limits, so they primarily check behavior outside the targeted workload.
Every output file count, byte check and output hash matched.

| Case | Qualifying groups | Baseline ms | Candidate ms | Candidate change | Control change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Single buffered | 4/6 | 31.30 | 29.55 | -5.6% | -17.7% |
| Multi buffered | 3/6 | — | — | Inconclusive | — |
| Single streamed | 2/6 | — | — | Inconclusive | — |
| Multi streamed | 3/6 | — | — | Inconclusive | — |
| Single local | 2/6 | — | — | Inconclusive | — |
| Multi local | 4/6 | 253.46 | 264.24 | +4.3% | -4.1% |
| Single markup | 3/6 | — | — | Inconclusive | — |
| Multi markup | 2/6 | — | — | Inconclusive | — |
| Single-threaded MDN replay | 3/6 | — | — | Inconclusive | — |

MDN uses three saved HTML acquisitions at depth zero, with networking disabled,
derived from `scripts/benchmark-mdn-crawl.mjs`. Three variants rotate/reverse in
one process after one warm-up each, with their own probe calibration and the
same whole-group rejection rule. All output hashes match the prior fixture
result. Groups 0, 3 and 4 were excluded, leaving too few for a timing conclusion.

Retain the change for the eliminated duplicate UTF-8 scans and measured bounded
pipeline improvement. The crawl results do not establish an overall speedup or
performance equivalence: most cases lack enough quiet groups, and qualifying
controls still vary. Probe qualification cannot remove all host and I/O noise.
