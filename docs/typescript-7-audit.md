# TypeScript 7 audit for 0.10.0

Keep TypeScript 6.0.3 for this release. Exclude the TypeScript 7.0.2 dependency
upgrade from the breaking release in its current form. Got 16's runtime upgrade
does not require changing the compiler.

## Compatibility evidence

The locked `typescript-eslint` 8.70.1 declares TypeScript `>=4.8.4 <6.1.0`;
`ts-jest` 29.4.14 declares `>=4.3 <7`. Loading the same ESLint configuration with
TypeScript 7.0.2 installed exits with:

> typescript-eslint does not support TS 7.0.

The TypeScript 7 package's root export exposes version information but lacks the
legacy `createProgram` and `transpileModule` functions used by existing tooling.
It has new unstable API exports; those are not compatible replacements for the
TypeScript 6 compiler API. Changing test runners alone would not remove the ESLint
dependency on TypeScript 6.

References: [TypeScript 7 announcement and side-by-side guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/),
[typescript-eslint tracking issue](https://github.com/typescript-eslint/typescript-eslint/issues/10940).

## Compiler-only measurements

Both compilers checked the same clean tracked-source snapshot at `c57bcdc`, with
the repository's locked dependencies, on Linux x64 and Node 24.18.0. Each ran
`tsc --project tsconfig.json --noEmit`, with one discarded warmup and five measured
fresh processes. Samples ran sequentially, TypeScript 6 followed by TypeScript 7.
This is a local warm-cache compiler comparison, not a CI or whole-build benchmark.

| Measurement | TypeScript 6.0.3 | TypeScript 7.0.2 |
| --- | ---: | ---: |
| Median elapsed time | 7.251 s | 1.509 s |
| Median peak process RSS | 571.75 MiB | 327.20 MiB |
| Installed compiler files, logical size | 23.22 MiB | 29.03 MiB |
| Installed compiler file count | 140 | 530 |
| Compiler check result | Passed | Passed |

RSS is Python `resource.getrusage(RUSAGE_CHILDREN).ru_maxrss` for each isolated
measurement process. It measures the largest process peak, not simultaneous
aggregate memory for the native compiler and its launcher. Footprints count the
compiler package and, for TypeScript 7, the installed Linux x64 native package;
they exclude npm cache, filesystem allocation overhead, and the rest of the
development graph. These are compiler footprints, not clean consumer-install sizes.

TypeScript 7 was about 4.8 times faster in this workload. A dual-compiler setup
would retain TypeScript 6 for tooling and add about 29 MiB of compiler files.
That is a viable future build optimization, but it does not simplify the graph
and would introduce another compiler/version pair to maintain.

## Emitted output

Both compilers emitted 47 JavaScript files and 47 declaration files. JavaScript
was byte-identical. Three declaration files differed only in string quote style
or union member ordering (`io.d.ts`, `logger/logger-worker.d.ts`, `util.d.ts`).
A strict TypeScript 6 consumer check with `--types node` verifies mutual assignability of the affected
exports. Both downloader modes passed the runtime smoke harness using TypeScript
7's emitted code. This establishes compiler viability for the snapshot, not
compatibility of the existing lint/Jest transformation pipeline with TypeScript 7.

Raw samples, package/API checks, and emission comparisons are recorded in
[the evidence JSON](evidence/typescript-7.json). Local logs and emitted trees are
under `artifacts/wse-010-implementation/compiler-audit/`.

## Revisit gate

Reconsider a direct upgrade when the chosen lint and test tools support the
TypeScript 7 API. A deliberate dual-compiler proposal should first show a useful
whole-build/CI improvement, a measured development-install tradeoff, declaration
consumer parity, and a clear version-update policy. The test-framework comparison
remains a separate release audit; this compiler result does not select a runner.
