# CSS replacement offsets and worker dispatch

Worker dispatch batching reduced elapsed time by about **44% in a focused pool
benchmark**. Broader crawl comparisons did not establish an overall speedup on
this noisy host. CSS replacement offsets are also corrected.

## Changes and validation

CSS replacement now locates each URL inside its argument instead of searching
from the start of the matched syntax. Previously, rewriting `url("url")` could
produce `assets/url("url")`; it now produces `url("assets/url")`. Similarly,
`@import "import"` preserves the keyword, and quoted whitespace retains the
correct replacement position. The existing regex and capture structure remain.

The worker pool keeps at most one pending `setImmediate` dispatch callback.
Submissions, completions and worker failures share that callback. Dispatch stays
asynchronous, and the pending flag resets before dispatch so a callback that
submits more work can schedule another turn. Worker balancing and capacity limits
are unchanged. Timer cleanup returns immediately when task deadlines are disabled.

`npm run build` and all **507 tests in 40 suites** passed. Added coverage checks
CSS offsets and actual rewrites, burst dispatch and capacity, submissions during
dispatch, and successful completion with an enabled deadline.

## Measurement setup

Measurements used Node 24.18.0 and identical dependencies. Tests and benchmarks
ran serially. Three compiled variants were compared:

- **Before:** `0156640`.
- **Timer:** before plus the CSS fix and disabled-timer cleanup guard.
- **Combined:** timer plus dispatch batching.

The timer/CSS suite compares timer against before. The dispatch suite compares
combined against timer, isolating the added effect of batching. Crawl suites
compare combined against before. Each comparison also launches an identical-code
baseline control in a separate process.

Each suite has six rounds, with a fresh process for each variant in every round.
Rotating and reversing order places each variant in each position twice. Each
process discards one warm-up per case and measures three focused observations or
two crawl observations. Its median contributes one observation to the comparison.

Fixed four-million-operation CPU probes bracket timed work. Before comparisons,
five probe warm-ups and nine calibration observations establish a threshold of
1.5 times the calibration median. If any measured probe exceeds that threshold,
the entire three-variant round is excluded for that case. At least four qualifying
rounds are required for timing comparisons. Exclusions do not depend on whether
the candidate is faster. All measured observations, including exclusions, remain
in the [portable evidence](evidence/css-worker-dispatch.json).

## Focused results

The dispatch case submits, dispatches, manually completes and settles 2,000 tasks
through the actual `WorkerPool`, using two simulated workers and real
`MessageChannel`s. Timing includes callback draining but excludes initialization,
shutdown and correctness checks. It does not measure real worker execution or
startup. Results, empty queues/maps and zero final worker loads were verified.

Four of six rounds qualified. Median times were **10.094 ms before batching,
10.813 ms for the identical-code control, and 5.647 ms with batching**. The
candidate change was **-44.1%**, compared with **+7.1%** for the control; the median
paired candidate change was -47.0%. Dispatch passes fell from **4,000 to 2** per
burst in every warm-up and measured observation. This supports reducing callback
overhead, without predicting an equivalent reduction in crawl time.

The other focused cases measure 100,000 disabled-timer cleanup calls, cancellation
of 2,000 enabled timers prepared outside timing, and 128 CSS parses of 256 ordinary
URL matches. Timer maps were empty afterward; CSS offsets and hashes matched.
Each case had only **2/6 qualifying rounds**, so their timing results are
inconclusive. No timer or CSS speedup is claimed.

## Small crawl results

Synthetic inputs contain six markup documents or twelve binary inputs, with
64 KiB buffered/local bodies and 256 KiB streamed bodies. Concurrency is eight,
with two workers in multithreaded cases and the default Got 16 transport.

| Case | Qualifying rounds | Before ms | Control ms | Combined ms | Candidate change | Control change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Single buffered | 4/6 | 42.90 | 34.50 | 36.44 | -15.1% | -19.6% |
| Multi buffered | 2/6 | — | — | — | Inconclusive | — |
| Single streamed | 2/6 | — | — | — | Inconclusive | — |
| Multi streamed | 3/6 | — | — | — | Inconclusive | — |
| Single local | 3/6 | — | — | — | Inconclusive | — |
| Multi local | 5/6 | 320.98 | 299.22 | 314.54 | -2.0% | -6.8% |
| Single markup | 3/6 | — | — | — | Inconclusive | — |
| Multi markup | 2/6 | — | — | — | Inconclusive | — |

The identical-code control changes exceed candidate changes in both qualifying
cases. These timings do not establish a crawl speedup or exact performance
equivalence; probe qualification cannot remove all host and process variability.

MDN replays three saved HTML acquisitions at depth zero with network disabled.
It is explicitly single-threaded and does not exercise worker dispatch changes.
All six MDN rounds failed the noise rule, so no timing comparison is reported.

All synthetic and MDN output checks and hashes matched. No extra rounds were
added to obtain favorable results. The retained changes fix CSS correctness and
remove redundant worker work; the focused batching measurement is the only
supported speedup claim from this pass.
