# Small implementation cleanups

Retained four cleanups, removing 22 net source lines:

- The pipeline uses the existing `isPromiseLike` utility instead of an identical
  private method. Synchronous hooks still return synchronously.
- Retry logging removes an unreachable branch and chooses its logger once.
  Log levels, arguments, timeout events, and the public hook export are preserved.
- Missing and numeric retry options share default construction, followed by one
  callback selection. Explicit object policies and custom callbacks are preserved.
- The default worker filename resolves directly from the module URL, then converts
  to a filesystem string. Custom filenames pass through unchanged.

The public `workingTasks` map remains `Map<number, PendingPromise>`. Its contents
are mutable even though the property is readonly; narrowing its value type would
reject existing callers inserting plain pending promises. Adding another map or
view solely to hide casts would not simplify ownership.

Build and all 469 tests in 39 suites passed. Additional local comparisons against
the baseline matched 16 retry configurations, eight log cases, four actual worker
factory invocations, and the public retry-hook identity. The only declaration
change removes the private promise-check method; public signatures are unchanged.

## Measurements

Baseline is `5914e89`, using the same dependencies and Node 24.18.0. These fresh
measurements do not reuse or pool earlier noisy runs. Tests and benchmarks ran
serially. All output hashes matched.

Synthetic workloads use six markup documents or twelve binary inputs, with
64 KiB buffered/local bodies and 256 KiB streamed bodies. Concurrency is eight,
with two workers. Local copies of `scripts/benchmark-crawl.mjs` reduce the input
counts and add independent fixed-work probes outside crawl timing.

Six rounds compare baseline, a separately launched identical-baseline control,
and candidate. Each variant runs in a fresh process, with one warm-up and two
measurements per case. Each process contributes one median. Rotating and reversing
order places every variant in every position twice.

Before launching benchmark processes, five CPU-probe warm-ups and nine calibration
samples set the rejection threshold to 1.5 times the calibration median. Probes
immediately before and after each crawl qualify the sample. Any failed probe
excludes the entire three-variant round for that case; at least four accepted
rounds are required. No new probes exceeded the threshold, so all six rounds
qualified in every case. No observations were filtered by candidate performance.

| Synthetic case | Before ms | Candidate ms | Change | Identical-code control change |
| --- | ---: | ---: | ---: | ---: |
| Single buffered | 24.46 | 22.33 | -8.7% | +5.6% |
| Multi buffered | 231.84 | 238.14 | +2.7% | +2.3% |
| Single streamed | 29.05 | 30.77 | +5.9% | -1.1% |
| Multi streamed | 29.11 | 29.96 | +2.9% | +2.1% |
| Single local | 6.75 | 6.35 | -5.8% | -2.8% |
| Multi local | 213.97 | 214.47 | +0.2% | +2.0% |
| Single markup | 80.16 | 77.80 | -2.9% | -3.3% |
| Multi markup | 413.92 | 421.34 | +1.8% | +1.4% |

The single-threaded MDN replay uses three saved HTML acquisitions at depth zero
with network disabled. One warm-up and six alternating pairs ran in one process,
with its own probe calibration and the same rejection rule applied to whole
pairs. All six pairs qualified. Median time changed from **293.55 to 294.97 ms
(+0.5%)**; median paired change was +2.1%.

These are maintainability changes with mixed timings, not an established overall
speedup. The controls still vary after probe qualification, and several cases
last only a few milliseconds. In particular, the +5.9% single-stream result is
about 1.7 ms; its median paired change is +2.2%. The data do not establish exact
performance equivalence or justify attributing the buffered improvement to these
small edits. Successful-request crawl timings do not exercise retry logging;
that path was checked for behavior equivalence.

[Portable evidence](evidence/minor-simplifications.json) retains all measured
timings, hashes, probe thresholds, and empty exclusion lists.
