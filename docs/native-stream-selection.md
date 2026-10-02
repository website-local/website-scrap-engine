# Native streaming selection experiment — 2026-10-02

Got 16 remains the production dependency and default transport. The candidate
in this report is an isolated diagnostic snapshot; no automatic native selection
has been enabled in source. The user chose to keep native streaming opt-in and
allow small residual streaming regressions if streaming is the only remaining
gate. Native retry support is being added separately; the zero-retry eligibility
below describes this historical automatic-selection experiment.

## Evidence separating engine checks from transport

A transport-only 24-sample run exercised 48 requests at concurrency eight,
validating every returned byte. It bypasses engine output publication entirely:

| Transport | Buffered median | Streaming median |
| --- | ---: | ---: |
| Got 13 | 55.66 ms | 73.46 ms |
| Got 13 extended with request defaults | 53.54 ms | 73.33 ms |
| Got 16 | 55.54 ms | 83.34 ms |
| Got 16 extended with request defaults | 53.48 ms | 87.62 ms |

Preconfiguring Got is not an established streaming improvement. The Got 16
streaming gap occurs without engine output checks. These are transport-only
measurements, not full-crawl acceptance results.

## Candidate behavior and tradeoff

Only streaming selection changes: omitted `httpTransport` attempts the existing
native backend when `canUseNativeHttp` accepts the request. Explicit `got` forces
Got; explicit `native` retains its existing behavior. Buffered requests retain Got.
Retries, request defaults, publication checks and byte limits do not change.

Eligible requests are GET/HEAD with zero retries, supported headers/redirects,
request timeout and decoding options, and no active Got-specific hooks. Unsupported
options fall back to Got before I/O. Default retry settings remain unchanged,
so this does not force native streaming for requests needing retries.

The tradeoff is observable: eligible streams expose NativeHttpResponse metadata
instead of Got request objects/timings, and native error objects instead of Got
classes. Existing native mode documents different default headers and supported
content encodings. Automatic selection therefore needs a separate transport-policy
decision; permission to relax engine checks alone does not settle that contract.

## Engine experiments

The 16-sample shared-process run compared 0.9.1, current/Got13, current/Got16,
and current/Got16 with automatic native streaming:

| Case | 0.9.1 | Got13 | Got16 | Native streaming candidate |
| --- | ---: | ---: | ---: | ---: |
| Buffered | 106.07 | 115.39 | 103.40 | 115.35 |
| Streamed | 173.65 | 173.12 | 183.78 | 147.52 |
| Local | 18.81 | 19.18 | 16.98 | 18.10 |

Buffered and local paths are unchanged between the last two variants. Their
variation is a control against attributing all elapsed differences to this patch.

Twelve balanced rounds in separate Node processes (one discarded warm-up per
process) measured streaming medians of 141.37, 128.65, 130.96, and 111.92 ms,
respectively. Native streaming is 14.5% below current Got 16 in that run. Got16
also falls below baseline in this run, unlike earlier runs: no stable claim that
all regressions are solved follows from a single favorable comparison.

All recorded crawl output hashes match. Raw snapshots, scripts and measurements
are under `artifacts/wse-focused-20261002`. The native candidate is `auto-stream`;
`path13` and `path16` contain the engine at commit cf085eb. The focused run is
`auto-stream-synth.json`, isolated run `auto-stream-isolated.json`, and transport
run `preconfigured-http.json`. Compact timings are retained in
[evidence](evidence/native-stream-selection.json).

## Decision and retry follow-up

Automatic native streaming was declined. The engine continues to use Got 16 by
default. The user also allowed small streaming regressions if streaming is the
only remaining gate, and required retries for opt-in native streaming.

Native now defaults to two retries. Supported declarative retry settings stay
on native, while custom retry callbacks and active Got-specific hooks select
Got. Interrupted streams restart the original request and replace partial bytes;
atomic output preserves the cached file when all attempts fail. Cancellation
interrupts backoff. See the migration guide for the full contract.

Build and all 455 tests in 38 suites passed, including native retry exhaustion,
Retry-After bounds, interrupted direct/atomic streams, cancellation during
backoff and fallback for custom callbacks. Logs are `native-retry-build.log`
and `native-retry-full-tests.log` under the artifact root. A new full comparison
uses two identical Got16 snapshots to measure same-code variation.

## Post-retry validation of the default Got transport

Sixteen samples per variant, balanced ordering, with byte-identical compiled
engine JS for the Got13 and both Got16 variants. Times are medians in ms:

| Case | 0.9.1 | Got13 | Got16 | Identical Got16 control |
| --- | ---: | ---: | ---: | ---: |
| SingleThreadDownloader buffered | 86.87 | 87.51 | 94.84 | 85.97 |
| SingleThreadDownloader streamed | 129.41 | 128.96 | 133.82 | 132.87 |
| SingleThreadDownloader local | 15.65 | 15.66 | 15.49 | 15.34 |
| SingleThreadDownloader markup | 339.64 | 281.11 | 292.49 | 286.57 |
| MultiThreadDownloader buffered | 456.68 | 367.38 | 356.54 | 363.73 |
| MultiThreadDownloader streamed | 167.42 | 128.02 | 127.85 | 132.36 |
| MultiThreadDownloader local | 399.46 | 290.70 | 271.64 | 287.40 |
| MultiThreadDownloader markup | 626.42 | 643.36 | 617.23 | 610.97 |
| MDN single-thread replay | 1072.79 | 1061.50 | 1051.98 | 1053.94 |

Every synthetic output check and MDN hash check passed. Streaming on Got16 is
3.4% slower than baseline here. Local, markup, and all multi-downloader cases
improve. MDN is 1.9% faster. Buffered differs 9.3% between identical Got16 builds,
which makes the apparent 9.2% baseline gap inconclusive in this shared process.
The follow-up uses separate processes and five measured buffered samples per
process after one warm-up, retaining each process as a measurement unit.
[Validation evidence](evidence/native-retry-validation.json) includes the compiled
code hashes and raw timing samples.

### Isolated buffered results and acceptance

The isolated check used 12 balanced rounds, four separate Node processes per
round, one warm-up and five measured buffered samples per process. Analysis uses
the median within each process, then the median across processes:

| Variant | Median of process medians |
| --- | ---: |
| 0.9.1 | 90.70 ms |
| 0.10/Got13 | 91.17 ms |
| 0.10/Got16 | 89.20 ms |
| Identical Got16 control | 93.17 ms |

Got13 differs by +0.5%; the identical Got16 copies bracket baseline (-1.7% and
+2.7%). The buffered difference is within measured same-code variation. This
supports treating buffered as within noise, rather than attributing the earlier
shared-process 9.2% difference to engine code. Exploratory paired bootstrap
intervals are preserved in the evidence; they are not equivalence guarantees
for other machines or workloads.

Under the user's revised acceptance condition, the current suites meet the
measured target: buffered within observed noise; local, markup, worker cases
and MDN faster; single-thread streaming has the accepted small residual (3.4%
in the final full run, 3.9% in the preceding full run). Native streaming stays
opt-in and now supports bounded retries. This is not a claim that Got16 streams
are faster than 0.9.1 or that every future measurement will improve.

Raw isolated results: `retry-isolated-buffered.json`. Full comparison results:
`retry-final-synth.json` and `retry-final-mdn.json`. Full runtime validation:
`native-retry-build.log` and `native-retry-full-tests.log` (455 tests / 38 suites).
