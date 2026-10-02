# Focused Node CPU profiling — 2026-10-02

The regression goal remains active. No new permissive runtime behavior has been
retained from these experiments. Got 16 remains the production dependency.

## Reproducible profiling

`benchmark-crawl.mjs` accepts `WSE_BENCH_CPU_PROFILE_DIR`. It uses Node's built-in
inspector CPU profiler at a 250-microsecond sampling interval for each measured
crawl, from initialization through disposal. Fixture preparation, explicit GC,
output hashing and fixture cleanup are excluded. Warm-up is not profiled.
Profiles cover the parent thread only, so use SingleThreadDownloader for complete
single-thread attribution; they do not capture worker execution. Run each engine
in a separate process to avoid shared-process version interactions.

Example (set TMPDIR and cache environment to approved local artifact paths first):

```sh
WSE_BENCH_SAMPLES=8 WSE_BENCH_MODES=SingleThreadDownloader \
WSE_BENCH_WORKLOADS=streamed,local \
WSE_BENCH_CPU_PROFILE_DIR=artifacts/wse-focused-20261002/example \
node --expose-gc scripts/benchmark-crawl.mjs /absolute/engine/lib/index.js
```

Profile timings are diagnostic, not performance acceptance measurements. CPU
sampling does not record every call or measure asynchronous wait duration.
Inspector start/stop work appears as `post` in the raw profiles and must be
excluded from attribution. Profiles and detailed self/inclusive summaries are
under `artifacts/wse-focused-20261002/scoped` and `scoped-summary.json`.

## Initial evidence

Whole-process `--cpu-prof` runs (24 samples, streaming and local) showed expensive
benchmark hashing outside crawl timing. The scoped profiles avoid that confound.
Across eight scoped local runs, engine self samples total 13.83 ms on 0.9.1,
23.85 ms on 0.10/Got13, and 23.95 ms on 0.10/Got16. These are sample sums, not
wall-time regression estimates. Streaming remains dominated by socket activity,
filesystem writes, idle time and garbage collection.

A balanced 24-sample unprofiled experiment tested broad diagnostic bypasses:

| Single-thread case | 0.9.1 | Got16 current | Publication bypass | Request signal bypass |
| --- | ---: | ---: | ---: | ---: |
| Streamed | 133.02 | 133.33 | 132.88 | 137.68 |
| Local | 15.89 | 15.20 | 16.59 | 15.69 |

Times are median milliseconds. The publication bypass replaced allocation and
ownership coordination with recursive mkdir and a direct writer, retaining
publication counting and save policy. The signal bypass omitted the signal only
from Got stream options and is a negative control for local files. Both retain
normal benchmark request/content/hash checks, which passed. Neither establishes
a useful gain, so neither is shipped. Unset byte limits already bypass their
stream transforms; removing those checks cannot explain this unlimited workload.

[Raw ablation timings](evidence/focused-profile-ablations.json) are retained.
Further work should isolate publication path preparation and stream setup costs,
measure changes without profiling, then run the full synthetic and MDN suites.
This checkpoint does not claim regressions have been eliminated.
