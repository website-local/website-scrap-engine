# Dependency and installation audit for 0.10.0

The audit keeps Got 16, p-queue 9, Cheerio, URI.js, and srcset. It removes the
automatically installed log4js tree from ordinary consumers by making the adapter's
dependency an optional peer. The existing Undici override remains a development
size optimization, with a project-local declaration mapping instead of postinstall
modification of vendor files. Compatible lint minor updates are applied; TypeScript
6 and Node 22 types remain selected.

[Recorded evidence](evidence/dependencies.json) contains installed file/package
counts, duplicate names, every timing sample, compressed archive sizes, artifact
integrity, and validation scope. The measurements use clean tracked snapshots,
not the workspace's unrelated untracked files.

## Runtime dependency decisions

| Dependency | Version audited | Decision |
| --- | --- | --- |
| Got | 16.0.0 | Keep the upgrade, public option snapshots, and Buffer compatibility wrapper |
| p-queue | 9.3.3 | Keep the bounded-concurrency queue; manage crawl ownership/cancellation outside it |
| Cheerio | 1.2.0 | Keep parsing and DOM behavior; do not use private imports or substitute a different parser to hide install costs |
| URI.js | 1.19.11 | Keep the public Resource URI contract and existing relative-URL/rewrite behavior |
| `@types/urijs` | 1.19.26 | Keep as a runtime package dependency because published declarations expose its types |
| srcset | 5.0.3 | Keep the small existing parser instead of adding another hand-maintained URL grammar |
| log4js | 6.9.1 | Optional peer for the explicit file-logging adapter; retained in development for validation |

Got provides retry, timeout, redirect, decompression, stream, progress, and request
hook behavior used by this library. Replacing it with native fetch would require
reimplementing these policies and proving equivalent range/conditional/cancellation
behavior. The audit found concrete migration defects and fixed them instead:
public `Options.toJSON()` snapshots avoid retained merge history, truncated
responses retain length validation, and Got 16's Uint8Array body is exposed as a
zero-copy Buffer view to preserve hooks and incomplete-HTML checks. HTTP options
no longer depend on `_internals` or private merge-history manipulation.

p-queue itself occupies 84,544 installed bytes and depends on eventemitter3 and
p-timeout. Its queueing, pause/start, and idle promises are already used publicly
through the downloader's queue. A custom replacement would add scheduling and
promise-settlement code for a small package-size saving. The implementation avoids
`clear()` during cancellation because it can leave accepted task promises pending.
Admission limits, cancellation, and the concurrency ceiling belong to the crawl
wrapper. Balanced throughput and worker stress measurements remain separate
release gates; this package-size audit does not claim a queue speed improvement.

URI.js is part of the normalized Resource API, not an incidental URL parser.
Replacing it with WHATWG URL would change relative URL, mutation, and rewrite
semantics and conflict with the chosen non-null URI-instance contract.

## Undici and Cheerio

The library downloads through Got. Cheerio's root entry also brings in Undici for
its own URL-loading API, which the built-in pipeline does not use. The measured
Undici 7.30.0 package contains 210 files and 1,658,921 bytes. The existing skip alias
contains seven files and 5,583 bytes: about **1.58 MiB saved in development**.
That remains a valid size benefit after dropping old Node versions.

npm does not inherit dependency packages' root overrides. Ordinary consumers still
install real Undici and get its real types; the packed declaration probe explicitly
rejects an `any` Dispatcher shim. No consumer node_modules modifications, fork,
or private Cheerio deep import are used. `cheerio/slim` changes the parser and
does not remove Undici from Cheerio's declared install graph, so switching imports
would not deliver the requested consumer-size reduction.

The former declaration-copy postinstall depended on nested dependency placement
and its source file was missing from the tarball. It is removed. The repository
TypeScript configuration maps Undici to the existing local shim, which is shipped
with the source/configuration. Both nested locked installs and fresh hoisted
installs type-check with lifecycle scripts disabled and vendor files untouched.

## Measured installation reduction

The final measured snapshot includes the optional-peer conversion and compatible
lint minor updates. MiB means 1,048,576 bytes; totals include installed npm metadata.

| Installation | Packages | Regular files | Logical size |
| --- | ---: | ---: | ---: |
| Development | 444 | 10,561 | 95.36 MiB |
| Ordinary consumer | 51 | 1,925 | 8.67 MiB |
| Consumer with `--omit=optional` | 51 | 1,925 | 8.67 MiB |
| Consumer explicitly adding log4js | 62 | 2,062 | 9.17 MiB |

Before conversion, ordinary consumers received log4js as an optionalDependency
even when using the default console logger. Making it an optional peer removes
eleven packages and about **0.51 MiB** without overrides or a new package name.
Adapter users install log4js explicitly. All three consumer variants pass strict
declaration checks and both downloader modes on Node 22.13.0. The peer harness also
checks absence from normal installs and actual log-file output when installed.

The measured package archive is 153,277 bytes compressed and 734,553 bytes unpacked.
It retains source and declaration maps for debugging and editor navigation.
Excluding source without reconsidering those maps would degrade that experience
for a comparatively small saving. The archive includes the declaration shim and
excludes the unrelated local shared-context sketch.

## Download and installation timing

One empty npm-cache install followed by five warm-cache reinstalls was measured
before the optional-peer conversion and lint minor updates. OS caches were not
flushed. These are observations on this machine and registry path, not universal
installation latency claims.

| Measured baseline | Empty npm cache | Warm median | Unique registry archive bytes |
| --- | ---: | ---: | ---: |
| Development | 11.624 s | 7.471 s | 18,522,070 |
| Consumer with automatic log4js | 3.662 s | 2.238 s | 1,930,500 |
| Consumer omitting optional packages | 2.952 s | 1.330 s | 1,789,091 |

Archive bytes come from npm's integrity-addressed compressed cache blobs for
installed packages. They exclude registry metadata, transport overhead, and the
local library tarball. The final ordinary consumer's registry integrity set is
identical to the last row, so its registry payload is 1,789,091 bytes; with the
measured library tarball, that is 1,942,368 compressed bytes. The eleven-package
logging tree accounts for 141,409 additional registry archive bytes.

## Import cost and interpretation

Fresh-process imports used one empty compilation-cache sample and five warm
samples on Node 24.18.0. Warm dynamic-import medians in the initial batches were
approximately 390 ms for the library, 287 ms for Cheerio, 135 ms for Got, and 9 ms
for p-queue. Dependencies overlap, so these values must not be summed.

The initial consumer without optional dependencies was about 16% slower to import
than the ordinary consumer. Alternating five more warm runs reduced the medians
to 415 ms and 431 ms, respectively, a gap of about 4%. Runtime resolution tracing
confirmed identical module graphs. The logging tree is not loaded by the default
entry, and the results do not support claiming a startup-speed benefit from its
removal. The adopted benefit is installation size and graph simplification.

## Tooling, duplicate packages, and advisories

globals 17.13.0 and typescript-eslint 8.71.0 are applied. The latter still requires
TypeScript `>=4.8.4 <6.1.0`; the [TypeScript 7 audit](typescript-7-audit.md) therefore
remains applicable. Node type definitions stay on 22.20.4 to model the runtime
minimum. The [runner audit](test-runner-audit.md) retains Jest while documenting
Vitest's smaller development graph and its measured tradeoffs.

The consumer graph duplicates entities at 4.5.0, 6.0.1, and 7.0.1 through different
DOM/parser dependencies, and lowercase-keys at 3.0.0 and 4.0.1 through responselike
and the newer HTTP stack. These are different major contracts, not redundant
copies safely removable by forcing a single version. Upstream dependency updates
are preferable to cross-major overrides or maintaining local forks. Most other
duplicate names are confined to development tooling and are recorded in the data.

`npm audit` reported zero known advisories for the updated development lock and
the ordinary consumer lock on 2026-10-01. Root development overrides do not protect
consumers; the consumer check uses its own resolved dependency graph.

This audit completes the dependency inventory and measured installation decision.
Final release validation must refresh packed consumers after remaining runtime
changes and cover the full Node 22.13/22/24/26 matrix. Resource outcomes, aggregate
buffer budgets, forced-worker cleanup, and balanced runtime performance/stress
work remain separate implementation gates.
