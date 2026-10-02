# Non-breaking simplification experiments

Retained two small changes: centralize executor/context cancellation checks and
reuse one lazily composed signal per publication lease; extract the shared retry
logging hook to remove the native/Got import cycle. Independent cancellation
signals and their precedence, the public retry-hook export, opt-in native HTTP,
and retries retain their behavior.

These are maintainability improvements, not a demonstrated overall speedup.
The comparison baseline is the rebased 0.10 candidate before these changes,
not 0.9.1. Measurements used Node 24.18.0, Got 16, rotating variant order,
one warm-up per case, and 12 measured samples per variant. Synthetic concurrency
was eight with two workers for multi-thread cases. Output hashes matched in every
case. [Evidence](evidence/safe-simplifications.json) retains timings and hashes
without machine paths.

| Synthetic case | Before median ms | Combined median ms | Change |
| --- | ---: | ---: | ---: |
| Single buffered | 78.46 | 82.93 | +5.7% |
| Single streamed | 117.24 | 117.33 | +0.1% |
| Single local | 14.86 | 14.56 | -2.0% |
| Single markup | 240.73 | 237.41 | -1.4% |
| Multi buffered | 317.91 | 308.30 | -3.0% |
| Multi streamed | 111.96 | 119.19 | +6.5% |
| Multi local | 244.17 | 244.30 | +0.1% |
| Multi markup | 669.74 | 651.30 | -2.8% |
| MDN | 1032.36 | 1017.93 | -1.4% |

MDN uses the single-thread downloader on 12 saved HTML acquisitions at depth
zero, with network disabled. It is a repeatable regression fixture, not a full
live crawl.

The apparent HTTP slowdowns warranted a fresh-process comparison: 12 balanced
rounds, one warm-up and three measurements per case per process. Each process
contributes one median, avoiding treating its three observations as independent.

| HTTP case | Before median ms | Combined median ms | Change | Median paired change |
| --- | ---: | ---: | ---: | ---: |
| Single buffered | 93.24 | 84.57 | -9.3% | -7.1% |
| Single streamed | 115.56 | 120.86 | +4.6% | +0.8% |
| Multi buffered | 324.67 | 321.43 | -1.0% | -2.6% |
| Multi streamed | 113.64 | 112.99 | -0.6% | -0.6% |

The earlier buffered and multi-stream slowdowns did not repeat. Single-stream
results remain mixed: combined won six of twelve paired rounds. These data do
not establish an overall throughput improvement or prove exact equivalence.
Retain the smaller implementation and preserved behavior; do not attribute the
large buffered difference to this small refactor.

Validation: build passed; 459 tests in 39 suites passed, including independent
cancellation precedence and cancellation of multiple allocations under one lease.
Exported worker state fields remain intact for compatibility.

## Remaining tradeoffs

A later [small cleanup pass](minor-simplifications.md) reuses the promise check,
consolidates retry defaults/logging, and shortens worker-path resolution. Its
fresh measurements are mixed; it makes no overall speedup claim.

Publication completion now uses the same parent-owned cleanup path for direct
and atomic writes, removing the extra release request for successful atomic
output. Output ownership, cancellation, and worker-exit cleanup remain intact.
See the [publication experiment](publication-simplification.md) for fresh small,
repeated measurements with explicit noise exclusions. This change does not
affect single-threaded MDN publication.

The subsequent [worker completion experiment](worker-completion.md) skips empty
successful cleanup and indexes connections by worker. Focused coordinator costs
fall; whole-crawl timings remain mixed.

Removing the metadata pre-clone changes snapshot/error timing. Bounded outcome
retention changes API availability. Single-boundary configuration normalization
can change caller-mutation and initialization-hook observability. Those require
explicit contract decisions; none is necessary for retaining these two changes.
