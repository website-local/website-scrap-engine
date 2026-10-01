# Test runner audit for 0.10.0

The comparison uses the 376 tests at `4c5bbd7`, including actual HTTP servers,
filesystem publication, worker processes, cancellation, and failure/retry checks.
Experimental dependencies and converted tests live outside the checkout under
`artifacts/wse-010-implementation/runner-audit/`; they are not release dependencies.

## Compatibility

| Runner | Trial | Minimum runtime check | Migration work |
| --- | --- | --- | --- |
| Jest 30.5.2 + ts-jest 29.4.14 | Existing full suite | Existing Node 22.13 checks | Keeps current matchers, ts-jest integration, and ESM VM/module-mock workarounds |
| Vitest 5.0.3 + Vite 8.3.1 | All 376 tests pass | All 376 pass on Node 22.13.0 | Replace imports and `jest` references; use `vi.mock` for top-level ESM mocks and `vi.doMock` for the nested mock helper |
| `node:test` | Four converted CSS tests and a separate ESM mock probe pass | Both probes pass on Node 22.13.0 | Replace assertion/mocking APIs; compile TypeScript and resolve `.js` imports; ESM module mocks still require an experimental flag |

Vitest's installed engine range is `^22.12.0 || ^24.0.0 || >=26.0.0`, compatible
with the release's Node 22.13 minimum. Its Vite peer adds a bundler/transform
toolchain. The prototype preserves file isolation and uses one test worker.
It does not remove tests or change their assertions to obtain a passing result.

The initial binary-response assertion failures revealed a production bug, not a
reason to weaken the tests: Got 16 supplies Uint8Array while our wrapper promised
Buffer. Explicit Buffer assertions and an incomplete-HTML HTTP regression now
cover that contract in both runners. The fix is `4c5bbd7`.

The initial fresh Vitest install also exposed the existing Undici declaration
stub's dependence on npm nesting. Restoring the repository lock before changing
the runner preserved the existing dependency placement and allowed compilation.
That packaging problem belongs to the dependency/install audit; changing runners
does not fix it.

Node's runner uses no added package. The CSS probe uses the same four fixtures and
`assert.deepStrictEqual` against compiled source. The separate mock probe replaces
an ESM named export using `mock.module`. That API is absent without
`--experimental-test-module-mocks` on Node 22.13 and 24.18. A full conversion was
not attempted, so the small probe cannot establish full-suite speed or migration
parity. Native type stripping also does not replace the compiler for this
codebase's TypeScript syntax and explicit `.js` source imports.

## Measurement method

Both complete suites use clean tracked snapshots on the same filesystem and Node
24.18.0 on Linux x64. Each runner gets one warm-up and five measured fresh-process
runs; Jest/Vitest order alternates. File and compilation caches remain warm.
Jest uses `--runInBand`; Vitest uses `maxWorkers: 1` with file isolation enabled.
Timing excludes lint. Native results cover only the four compiled CSS tests and
are not comparable to either full-suite total.

Memory measurements use Python `getrusage(RUSAGE_CHILDREN)` in a fresh measurement
process for each run. They report the largest single-process RSS, including child
processes, not the sum of parent and worker memory. Runtime harnesses compile and
spawn children under both full-suite runners.

## Results and decision

[Raw measurements](evidence/test-runners.json) include every sample, commands,
lockfile hashes, installed file counts, and duplicate package names.

| Measurement | Jest | Vitest |
| --- | ---: | ---: |
| Full-suite median | 36.730 s | 40.468 s |
| Median maximum process RSS | 576.90 MiB | 576.58 MiB |
| Installed development packages | 444 | 190 |
| Installed regular files | 10,559 | 4,801 |
| Logical development install size | 95.33 MiB | 83.98 MiB |

Vitest saves 11.35 MiB and 254 installed packages in this trial. These totals
include runtime dependencies, exclude generated runner caches and symlink entries,
and do not measure consumer installations. Retaining Jest has a measurable
installation cost; package counts alone exaggerate the byte-size difference.

Vitest is about 10.2% slower in these single-worker warmed runs. Its report
attributes roughly 4.5 seconds to spawning isolated per-file workers, consistent
with the observed 3.74-second gap. Disabling isolation could reduce that overhead,
but changes mock/global-state semantics and was not used to claim a speedup.
These numbers do not establish a winner under parallel CI or watch-mode workloads.
Peak process RSS is dominated in part by compiler subprocesses; it is not evidence
that both runners have equal aggregate memory consumption.

The native four-test probe has a 0.221-second median and 33.26 MiB median maximum
process RSS, excluding compilation. It is deliberately not placed in the full
suite table because it performs much less work.

**Retain Jest for 0.10.0.** Vitest is a viable future replacement, with substantially
fewer installed packages, but this trial shows no full-suite speed advantage.
The current repository instruction also prohibits adding tracked dependencies.
A future migration should repeat the comparison under the intended CI parallelism,
keep isolation, and include full TypeScript checking and coverage validation.
Changing the runner would not unblock TypeScript 7 while ESLint's TypeScript
integration remains incompatible.

Do not migrate the whole suite to `node:test` in this release. Its zero-package
runner is attractive, and existing real-process harnesses already use Node's
assertions. Full conversion would require substantial assertion/mock changes,
while ESM module mocking is still experimental at our supported minimum. The
small prototype provides no evidence that this migration would preserve all
current behavior more reliably.

## Test hardening adopted

The trial exposed two typing differences in the Vitest conversion: generic mock
inference erased a Resource subtype, and an ES2022-only compilation lacked
Promise.withResolvers. Explicit generic hook wrappers and a conventional Promise
barrier preserve the tests without casts or higher library targets. A standalone
check of the existing Jest suite also found an untyped Got hook and a logger mock
whose inferred zero-argument signature contradicted its assertions; both now use
their production callback types.

`npm run check:tests` now checks the complete source/test TypeScript project, and
`npm test` runs it before Jest. This does not depend on ts-jest's per-file/cache
behavior and would also be required for Vitest, whose runtime transformations do
not provide a full TypeScript check. The new check was added after the timing
experiment, so its time is excluded from both runner totals above.
