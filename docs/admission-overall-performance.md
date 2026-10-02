# Admission size reuse and current performance against 0.9.1

Queue admission now reuses the byte count calculated for `maxResourceBytes`
validation when reserving `maxBufferedBytes`. Resource validation still runs
before duplicate detection and queue-limit rejection. Buffer reservation stays
after those checks, including transfer of already-reserved child bytes.

When only the buffer limit applies, sizing remains deferred until admission:
rejected duplicates do not gain an unnecessary scan. Undefined and empty bodies
retain their behavior, and each admission calculates from its current body and
encoding. No size is cached across admissions or hooks. Public signatures and
configuration are unchanged.

Build and all **494 tests in 40 suites** passed. Four new cases cover resource
validation versus duplicate/queue/buffer limits, exact encoded-byte accounting,
empty and undefined bodies, updated bodies/encodings on later admissions, credit
release and child-credit transfer at a full budget.

## Comparisons and noise rule

These are fresh measurements, not combined percentages from historical reports.
The candidate is `3f46212` plus admission size reuse. The focused test compares
that parent commit, a separately launched identical-parent control and candidate.
The complete crawl comparison uses **0.9.1, candidate and an identical-candidate
control**. The admitted bodies in the default crawl fixtures are undefined and
byte limits are disabled, so admission size reuse is inactive there; that
comparison measures the cumulative engine/dependency changes.

Both comparisons use Node 24.18.0 and six balanced rounds. Every variant runs in
a fresh process, including MDN. Order rotates/reverses so each variant occupies
each position twice. One warm-up per case is discarded. Each process contributes
one median from three focused or two crawl observations. All tests and benchmark
suites ran serially.

Independent CPU probes perform four million fixed integer operations immediately
before and after timed work. Five probe warm-ups and nine calibration samples
set each suite's threshold to 1.5 times its calibration median before comparisons
start. Any measured probe above that threshold excludes the **whole three-variant
group for that case**. At least four qualifying groups are required for timing
comparisons. Thresholds were not loosened and groups were not selected by which
version won. No additional runs were made to obtain favorable results.

[Portable evidence](evidence/admission-overall-performance.json) retains every
observation, calibration, threshold, exclusion and runtime fingerprint.
Qualification cannot eliminate all filesystem, scheduling and GC variation.

## Focused admission result

Each observation queues 128 resources referring to one reused 256 KiB body.
UTF-8 input repeats an emoji; the binary case contains the same encoded bytes.
Downloader initialization, resource construction and disposal are outside timing.
Queue length, reservation totals, rejection behavior and released credits are
checked outside timing. This measures admission, not resource processing or I/O.

| Case | Qualifying groups | String-size scans before → after per admission |
| --- | ---: | ---: |
| UTF-8, both limits | 0/6 | 2 → 1 |
| Binary, both limits | 1/6 | 0 → 0 |
| UTF-8, buffer limit only | 2/6 | 1 → 1 |
| UTF-8, neither limit | 3/6 | 0 → 0 |
| UTF-8, buffer limit only, rejected duplicate | 2/6 | 0 → 0 |

The scan counts come from a separate untimed diagnostic, consistent across all
six rounds. The implementation removes the duplicate scan as intended. **All
focused timing comparisons are inconclusive** under the preselected noise rule;
no speedup percentage is claimed from the rejected measurements.

## Direct comparison against 0.9.1

The retained 0.9.1 compiled JavaScript matches the original baseline byte-for-byte.
Both versions use per-package symlinks, with shared runtime packages resolving
to the same physical dependency directories. Got/p-queue remain 13.0.0/8.1.1 in
0.9.1 and 16.0.0/9.3.3 in current code. Shared Cheerio, URIjs and srcset versions
are 1.2.0, 1.19.11 and 5.0.3. Current installed package versions and direct runtime
package JS/JSON content were checked against the shared installation.

Synthetic cases use six markup documents or twelve binary inputs, 64 KiB
buffered/local bodies, 256 KiB streamed bodies, concurrency eight and two workers.
They include initialization, crawling and disposal. The harness derives from
`scripts/benchmark-crawl.mjs`; requests disable retries and use Got. Every output
count, byte check and hash matched across versions.

| Case | Qualifying groups | 0.9.1 ms | Current ms | Identical current ms | Current vs 0.9.1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Single buffered | 3/6 | — | — | — | Inconclusive |
| Multi buffered | 2/6 | — | — | — | Inconclusive |
| Single streamed | 3/6 | — | — | — | Inconclusive |
| Multi streamed | 0/6 | — | — | — | Inconclusive |
| Single local | 1/6 | — | — | — | Inconclusive |
| Multi local | 4/6 | 470.38 | 317.28 | 304.92 | -32.5% |
| Single markup | 2/6 | — | — | — | Inconclusive |
| Multi markup | 2/6 | — | — | — | Inconclusive |
| Single-thread MDN replay | 5/6 | 347.54 | 342.68 | 342.24 | -1.4% |

Worker local-file elapsed time is about **33% lower** in the qualifying groups;
its median paired change is -32.5%, and the identical-current control differs
-3.9%. This includes worker startup and does not isolate steady-state throughput.

MDN replays three saved HTML acquisitions at depth zero with networking disabled,
using the same lifecycle code apart from the current engine's save-path adapter
and direct single-thread import. Its output hash matches the established fixture.
Group 4 was excluded. The observed difference is small: -1.4%, with an identical
current control difference of -0.1%. This is a single-thread result and cannot
be attributed to worker-coordinator changes.

Most cases lack enough quiet groups to characterize current performance. These
results support the worker local-file improvement and record a small MDN
difference; they establish neither an aggregate speedup nor that every previous
regression is resolved. Earlier streaming and buffered findings are not replaced
with new percentages from this noisy run. Got 16 remains default and native HTTP
remains opt-in.
