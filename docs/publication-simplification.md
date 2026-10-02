# Worker publication completion

Successful direct and atomic writes now share one parent-owned completion path:
publish, clean the allocation, then acknowledge the worker. A successful atomic
output needs two publication requests instead of three. The worker sends release
only for unpublished allocations. Failed publications remain registered for
release or task cleanup; failed workers still must exit before cleanup starts.
Destination ownership, cancellation, publication counts, and byte accounting
retain their existing contracts. No public options or declarations change.

This is a small maintainability improvement with one less round trip for atomic
output, not a demonstrated overall throughput gain. Single-threaded MDN does
not use this worker completion path.

## Measurements

Baseline: `3d74b91`, with the same dependencies and Node 24.18.0. The candidate
also includes the retry-delay minimum fix; synthetic HTTP requests succeed
without retries, so that fix is not exercised by these timing comparisons.

Earlier publication-consolidation runs are excluded from these aggregates because
host load was not independently qualified. Fresh runs use local copies of
`scripts/benchmark-crawl.mjs` and `scripts/benchmark-mdn-crawl.mjs`: six HTML
documents or twelve binary inputs per synthetic crawl, and three saved HTML
acquisitions for the single-threaded MDN replay. Payload sizes remain 64 KiB
buffered/local and 256 KiB streamed; concurrency is eight with two workers.
MDN runs at depth zero with network disabled. All output hashes matched.

Each case has one discarded warm-up and six alternating pairs. Independent
fixed-work CPU probes bracket each crawl outside its timing. Before measurements,
five probe warm-ups and nine calibration samples set a threshold of 1.5 times
the calibration median. If either variant exceeds that threshold, both members
of its pair are excluded. Four of 66 pairs were excluded: multi buffered pair 0,
multi streamed pair 5, and MDN pairs 0 and 1. No pairs were removed based on
whether the candidate won or lost. Raw samples, probes and exclusions are in the
[evidence](evidence/publication-simplification.json).

Small synthetic cases still showed large swings after those exclusions. A
fresh-process check covered buffered, streamed and local cases with four rounds
in rotating/reversed order, including a separately launched identical-baseline
control. Baseline/candidate ordering is balanced; the control's positions are
not fully balanced in four rounds. Each process
has one warm-up and three measurements per case and contributes one median;
observations within a process are not treated as independent. The original probe
threshold remains fixed. A process needs two qualified measurements; otherwise
its entire three-variant round is excluded. One measurement was excluded; all
four rounds qualified per case.

| Fresh-process case | Before ms | Candidate ms | Change | Identical-code control change |
| --- | ---: | ---: | ---: | ---: |
| Single buffered | 21.98 | 22.42 | +2.0% | +14.8% |
| Multi buffered | 242.40 | 248.52 | +2.5% | +5.8% |
| Single streamed | 30.22 | 32.05 | +6.1% | +19.7% |
| Multi streamed | 29.31 | 28.88 | -1.5% | +31.6% |
| Single local | 6.78 | 6.82 | +0.5% | +0.7% |
| Multi local | 217.04 | 217.48 | +0.2% | +1.5% |

The first pass's large single-local (+37.9%) and multi-streamed (+38.6%) changes
did not repeat. The identical-code controls show that host probes cannot remove
all scheduling and process variation. These short runs do not establish a
repeatable slowdown, a speedup, or exact performance equivalence.

The remaining cases use the initial six-pair run, with four accepted MDN pairs:

| Case | Before ms | Candidate ms | Change | Median paired change |
| --- | ---: | ---: | ---: | ---: |
| Single markup | 83.16 | 85.39 | +2.7% | +0.6% |
| Multi markup | 519.38 | 529.10 | +1.9% | +1.0% |
| Atomic multi local | 273.58 | 279.65 | +2.2% | +3.2% |
| Atomic multi markup | 429.38 | 437.19 | +1.8% | -0.8% |
| MDN replay | 303.63 | 300.40 | -1.1% | -0.5% |

## Validation

Build and all 469 tests in 39 suites passed. Publication tests check the missing
release request after success in both modes, idempotent cleanup, and retention
of failed-worker staging until exit. The full suite covers cancellation,
destination conflicts, confirmed output after worker failure, discovery,
byte budgets, and stable outcomes.

Seven new retry regressions failed before the separate minimum-delay fix and
passed afterward, including real HTTP 500 and 429 recovery. Previously, first
retry jitter below 1 ms was truncated to zero (about 0.5% of first retries), and
`Retry-After: 0` or an HTTP date equal to the current time also returned zero.
Got interprets zero as stopping retries. Eligible retries now wait at least 1 ms;
exhausted limits and ineligible requests still return zero.
