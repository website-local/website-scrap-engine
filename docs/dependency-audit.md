# Dependency and tooling decisions for 0.10

Keep the current runtime dependencies and TypeScript/Jest toolchain for 0.10.
The consumer installation reduction comes from making log4js an optional peer.
Parser replacement and compiler/test-runner migration are outside this release.
See the [release audit](release-0.10.0-audit.md) for current validation status.

## Runtime packages

| Package | Audited version | Decision and reason |
| --- | --- | --- |
| Got | 16.0.0 | Default transport; preserves the request hooks, agents, retry, timeout, redirect and streaming contracts |
| p-queue | 9.3.3 | Retain queueing, pause/start and idle behavior; crawl limits and cancellation remain in the wrapper |
| Cheerio | 1.2.0 | Retain parsing, DOM and rewrite behavior |
| URIjs | 1.19.11 | Retain the public Resource URI-instance contract and relative-URL/mutation semantics |
| `@types/urijs` | 1.19.26 | Runtime dependency because published declarations expose these types |
| srcset | 5.0.3 | Retain the existing grammar instead of adding a local parser |
| log4js | 6.9.1 | Optional peer for the explicit file-logging adapter; also used in development validation |

Got options use public `Options.toJSON()` snapshots and preserve hooks/agents
without accumulating merge history. Got 16 Uint8Array bodies are exposed through
a Buffer view to preserve the library's Buffer contract. The native HTTP(S)
transport remains opt-in, with automatic Got fallback for unsupported options;
see the [migration guide](../MIGRATION-0.10.0.md#native-http-transport).
The version/transport experiments did not justify rolling back Got or selecting
native streaming automatically.

Replacing p-queue would add scheduling and promise-settlement code without a
proven crawl improvement. Cancellation avoids `clear()` because accepted task
promises can otherwise remain pending. Ownership, admission and byte accounting
remain explicit engine responsibilities.

## Installation and packaging

The optional-peer conversion removes eleven automatically installed logging
packages, about 0.51 MiB in the original installation comparison. Ordinary
consumers install log4js only when they choose that adapter. Historical packed
checks consistently found **51 packages without the peer and 62 with it**.
Removing the logging tree did not establish a startup-speed improvement; default
imports already avoided it.

Cheerio's root API declares Undici even though the pipeline downloads through Got.
The existing development skip alias saves about 1.58 MiB in the audited install.
Root npm overrides are not inherited by consumers: consumers install real Undici
and their declarations are checked against its real types. The removed
postinstall declaration-copy hack is replaced by the project's explicit local
TypeScript declaration mapping, shipped with the source/configuration.

Private Cheerio imports or `cheerio/slim` would not remove Undici from its declared
installation graph; switching parsers also changes behavior. Source and declaration
maps remain packaged for debugging/editor navigation. Exact tarball sizes belong
to their recorded artifacts, not a later candidate.

Different entities and lowercase-keys majors reflect parser/HTTP dependency
contracts. The audit does not force them to one major through overrides. The
2026-10-01 audit reported zero known advisories in the tested development and
consumer graphs; that is a dated result, not a current registry claim.
whatwg-encoding's deprecation is tracked through its upstream Cheerio chain.

[Installation evidence](evidence/dependencies.json) retains file counts, sizes,
registry payloads and timing samples. The [historical package refresh](evidence/final-package.json)
and [later quality-pass package checks](evidence/final-quality-pass.json) identify
their own candidates and limits.

## Development tooling

| Tool | Retained choice | Evidence and tradeoff |
| --- | --- | --- |
| TypeScript | 6.0.3, Node 22 types | Current compiler API works with ESLint and ts-jest; types model the minimum supported runtime |
| ESLint integration | typescript-eslint 8.71.0; globals 17.13.0 | Compatible audited updates; TypeScript range remains below 6.1 |
| Test runner | Jest 30.5.2 + ts-jest 29.4.14 | Existing suite and isolation semantics; no measured full-suite speed benefit from migrating |

The historical compiler-only trial at `c57bcdc` measured median checks of
7.251 seconds for TypeScript 6.0.3 and 1.509 seconds for 7.0.2, with lower peak
process RSS for TS7. However, TS7 lacks the legacy compiler API used by the current
ESLint integration; ts-jest also excludes TS7. A dual-compiler setup adds a second
compiler installation. Revisit when supported integrations can lint, typecheck,
test and emit the published declarations without that duplication.
[Compiler evidence](evidence/typescript-7.json) records the precise trial.

At the earlier 376-test checkpoint, five warmed alternating runs measured
36.730 seconds for Jest and 40.468 seconds for Vitest with isolation and one worker.
Vitest saved 254 development packages and 11.35 MiB in that trial, but did not
improve elapsed time. These numbers do not predict parallel CI or watch mode.
The four-test `node:test` prototype was too small to establish full-suite parity;
ESM module mocking remained experimental at the minimum runtime.
[Runner evidence](evidence/test-runners.json) includes the migration trial.

`npm test` runs lint, explicit source/test typechecking and Jest. Transpilation
inside a runner is not a replacement for `npm run check:tests`.

## Parser replacements

Cheerio and URIjs stay in 0.10. The public URI object contract, serialization,
relative resolution, deduplication and save-path rewriting need a defined
compatibility corpus before migration. The separately developed HTML alternative
is not integrated into this release.

A Node 24.18.0/Ada 3.4.4 microbenchmark found built-in WHATWG URL parsing/resolution
and serialization about **4.3–7.0 times faster** than URIjs for the selected
canonical ASCII HTTP(S) operations, with matching outputs for those fixtures.
It did not measure whole crawls, heap pressure, mutation/getter-heavy use, malformed
input, Unicode or divergent file-URL behavior. Compliance does not by itself imply
slower processing, and conversion back to URIjs for hooks could erase the gain.
[URL evidence](evidence/url-parser-comparison.json) retains the cases and controls;
no engine-wide speedup or drop-in compatibility is claimed.

Full dependency, compiler, runner and parser reports are merged into the
[historical archive](archive/0.10.0-experiments.md#dependency-audit).
