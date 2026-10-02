# Worker completion and connection lookup

Successful tasks with no publication allocations or operations now remove their
lease without constructing an abort error or draining empty collections. An
existing close remains authoritative: calling successful close after failed
close cannot bypass the worker-exit wait. Failed tasks still wait for their
assigned worker to exit, including tasks that never allocated an output file.
Tasks with pending operations or unpublished allocations keep the full cleanup.

The coordinator's private connection set is now a map keyed by worker object,
matching the factory's one-publication-channel-per-worker arrangement. Assignment
does a direct lookup instead of allocating an array and searching it. Exit removes
that worker's entry, and disposal still closes every registered connection.
Public signatures and the separate public `workingTasks` map are unchanged.

Build and all **473 tests in 39 suites** passed. Four focused tests cover late
requests after empty completion, byte-credit release after failed-worker exit,
pending operations without allocations, and worker identity/exit during assignment.
The existing suite covers atomic cleanup, cancellation, output ownership,
discovery and byte budgets, including failure before the first worker RPC.

## Measurement setup

Three variants use identical dependencies and Node 24.18.0:

- **Before:** `72e2e73`.
- **Fast:** only the successful-completion fast path.
- **Combined:** fast path plus connection map.

Fast versus before isolates completion. Combined versus fast measures the added
effect of the map. These are incremental comparisons, not a map-only experiment.
No earlier timings are pooled with this run.

Focused coordinator and synthetic comparisons use six rounds, one fresh process
per variant per round. Rotating/reversing order places every variant in every
position twice. Each process has one warm-up per case, then three focused or two
synthetic measurements and contributes one median per case. Tests and benchmarks
run serially.

Independent fixed-work CPU probes bracket each timed operation/crawl. Before
launching children, five probe warm-ups and nine calibration samples fix a
threshold of 1.5 times the calibration median. Any measured probe exceeding it
excludes the entire three-variant round for that case; at least four rounds are
required. No observations are excluded based on candidate performance.

All six focused rounds qualified. Five synthetic case-rounds were excluded:
single buffered round 5, multi buffered round 0, single streamed round 3, multi
streamed round 0, and multi markup round 3. The MDN replay excluded group 5.
[Portable evidence](evidence/worker-completion.json) retains all samples and probes.

## Focused coordinator results

The completion case registers and finishes 2,000 empty successful leases.
Assignment cases perform 40,000 lookups across two or eight attached worker
objects. These run in process with message channels and simulated worker objects;
they exclude file I/O and actual worker startup. Cleanup and correctness checks
run outside timing.

| Case | Before ms | Fast ms | Combined ms |
| --- | ---: | ---: | ---: |
| 2,000 successful completions | 18.815 | 1.134 | 1.131 |
| 40,000 assignments, 2 workers | 2.273 | 2.062 | 1.547 |
| 40,000 assignments, 8 workers | 3.043 | 2.988 | 1.855 |

Completion is about **94% cheaper** in this focused test, saving roughly 8.8 µs
per task. The map's incremental assignment improvement is **25% with two workers**
and **38% with eight**, saving roughly 13–28 ns per lookup. These savings are small
relative to a crawl's I/O, parsing and worker startup; they are not throughput gains.

## Crawl results

Synthetic cases use six markup documents or twelve binary inputs; payloads remain
64 KiB buffered/local and 256 KiB streamed. Concurrency is eight, with two workers.
Each variant uses the same small harness derived from `scripts/benchmark-crawl.mjs`.
All crawl output hashes matched.

| Case | Before ms | Fast ms | Combined ms | Combined vs before |
| --- | ---: | ---: | ---: | ---: |
| Single buffered | 27.62 | 29.97 | 26.79 | -3.0% |
| Multi buffered | 259.94 | 268.20 | 266.71 | +2.6% |
| Single streamed | 36.33 | 35.99 | 34.84 | -4.1% |
| Multi streamed | 35.91 | 36.09 | 36.68 | +2.1% |
| Single local | 7.35 | 7.23 | 7.18 | -2.3% |
| Multi local | 231.09 | 237.19 | 240.02 | +3.9% |
| Single markup | 90.24 | 83.87 | 81.44 | -9.7% |
| Multi markup | 460.04 | 457.87 | 454.63 | -1.2% |
| MDN replay | 318.30 | 333.45 | 329.15 | +3.4% |

MDN uses three saved HTML acquisitions at depth zero, single-threaded with network
disabled. Its three variants rotate/reverse order in one process for six groups,
after one warm-up each. Its own calibration uses the same probe rule; five groups
qualify. The coordinator edits do not execute on this path, making it a useful
timing control.

Retain both changes for the measured reduction in coordinator work and the direct
lookup. Whole-crawl timings remain mixed; these short noisy-host runs establish
neither an overall speedup nor exact performance equivalence. Probe qualification
does not eliminate all host, filesystem and process variation.
