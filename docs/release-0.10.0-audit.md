# 0.10.0 release audit

**The two known correctness blockers are fixed and committed. CI passed for
`a1f5fb1`, as reported by the user. Release sign-off still requires finalizing
the remaining working-tree changes and validating the resulting release artifact.**
0.10.0 remains unreleased.

Use the [migration guide](../MIGRATION-0.10.0.md) for public contracts and upgrade
steps, [performance report](performance.md) for measurements, and
[dependency audit](dependency-audit.md) for package/tooling decisions. Earlier
checkpoint narratives are preserved in the [archive](archive/0.10.0-experiments.md#release-0.10.0-audit).

## Candidate and validation status

| Scope | Result | Evidence and limits |
| --- | --- | --- |
| Committed correctness fixes, `a1f5fb1` | 511 tests / 40 suites, lint, strict source/test types, build and real Got retries passed on Node 22.13.0 | [Acceptance evidence](evidence/repair-acceptance.json); isolated snapshot contained only the accepted code changes |
| Hosted CI for `a1f5fb1` | Passed, user-reported after push | Configured Ubuntu matrix: Node 22.13.0, 22.x, 24.x, 26.x, including installed-package/declaration checks; no run logs or API status were fetched |
| Earlier frozen runtime: `a7d2dbf` plus retained worker cleanup | 507 tests / 40 suites passed on Linux Node 22.13.0, 22.23.3, 24.21.0 and 26.10.0 | [Quality-pass evidence](evidence/final-quality-pass.json); predates the two correctness fixes |
| Earlier packed consumers | Strict declarations and 13 runtime harnesses passed on the four Linux versions, with and without log4js | Same historical artifact; not a package sign-off for the changed release tree |
| Earlier native Windows consumers | Node 22.13.0 and 24.21.0 passed general and filesystem harnesses, including permitted symlinks | Historical artifact; Windows validation must be refreshed for the final package |
| Latest working-tree benchmark against 0.9.1 | All nine workload output checks passed; 10–12 rounds retained per case | [Latest 0.9.1 evidence](evidence/idle-working-tree-performance.json); multi buffered HTTP is faster under the paired-control rule; six comparisons remain provisional |
| HTTP-cache mitigation, committed as `584e07c` | 527 tests / 41 suites, lint, strict source/test types, build and both downloader smoke checks passed on Node 22.13.0 | [Mitigation evidence](evidence/http-cache-mitigation.json); includes 16 new cases and confirmed failures without the guard; upstream advisory remains open, outside the reported CI pass |
| Allocation candidate after `584e07c` | 531 tests / 42 suites, lint, strict source/test types and build passed on Node 22.13.0; eight crawl output checks matched | [Follow-up evidence](evidence/performance-memory-followup.json); sampled allocation reductions in CSS/SVG/link creation, no confirmed elapsed-time or RSS improvement; quiet-host latency gate pending |
| Markup/path candidate after `8c7a290` | 534 tests / 42 suites, lint, strict source/test types and build passed; eight synthetic crawl outputs and local MDN outputs matched | [New evidence](evidence/markup-path-followup.json); MDN elapsed time -6.11% normally and -4.66% under pressure passes controls; other focused comparisons remain partly unresolved, no aggregate non-regression sign-off |
| Redirect helper reuse after `2382067` | 534 tests / 42 suites, lint, strict types and build passed; 100,000 path equivalence checks matched | [Redirect evidence](evidence/redirect-reuse-investigation.json); lower sampled allocation in path calculation, no confirmed saving-stage speedup; inline-CSS marker experiment excluded |

The latest benchmark against 0.9.1 snapshots the tracked working tree based on `a1f5fb1`,
including the retained `src/downloader/multi.ts` cleanup and two local QA harnesses.
The cleanup narrows an already-validated worker-result type and removes an
unreachable branch. The unrelated untracked `src/shared-context.ts` sketch is
excluded from that build. Benchmark fingerprints identify the exact runtime;
subsequent documentation edits do not alter its code.

The later HTTP-cache mitigation is outside that benchmark snapshot and the
reported CI pass. It bypasses cache lookup for `max-stale` requests in the built-in
transports; the [dependency audit](dependency-audit.md) records the still-open
upstream advisory and its scope.

The allocation candidate was compared with the tracked tree based on `584e07c`,
including the inherited worker cleanup. It reduces unnecessary awaits, synchronous
hook closures and CSS regex captures. The 15,000-input CSS equivalence check and
eight small crawl comparisons passed. Its loaded-host timing controls did not
qualify any speed or non-regression claim; see the
[performance report](performance.md#allocation-follow-up-2026-10-03). Neither these
changes nor the HTTP-cache mitigation are covered by the earlier CI result.

The retained worker cleanup and earlier QA/documentation changes still require
inclusion or exclusion when finalizing the release commit. The committed CI result
does not automatically cover those uncommitted changes.

## Accepted correctness fixes

Commit `a1f5fb1` applies both measured fixes and four regression cases:

- **Retry delay overflow:** a long-expired HTTP-date could wrap through signed
  32-bit conversion into a long future delay. For example, at the fixed time
  2026-10-02 14:30 UTC, an epoch `Retry-After` produced 49,962,432 ms. The fix removes
  premature truncation, rejects non-finite header delays and bounds eligible
  final delays to 1–2,147,483,647 ms. Zero remains available for ineligible retries;
  eligible immediate retries stay positive because Got treats zero as cancellation.
- **Directory-index metadata:** selecting `index.html` or `index.htm` retained
  the directory's stat. The fix invalidates that stat so headers and timestamps
  describe the selected file. Both index names have regression coverage.

Both defects reproduced in 0.9.1 and the frozen pre-fix runtime. The user accepted
the measured performance tradeoff and authorized committing the exact tested patch.
That acceptance supersedes the earlier performance blocker; it does not turn the
noise-limited experiments into proof of strict non-regression. See the
[repair experiment history](archive/0.10.0-experiments.md#repair-repeat-measurement)
and [raw repair measurements](evidence/repair-repeat-measurement.json).

## What the quality pass covers

Focused tests and real-process harnesses cover hook/resource invariants, worker
messages and ownership, startup/task deadlines, cancellation and awaited disposal,
retry/outcome accounting, redirects, byte reservations, output conflicts and
atomic/direct publication. Consumer checks cover exported declarations, native
HTTPS, lazy imports and the optional logging peer. Windows checks include encoded
file URLs, buffered and streaming local input, junctions/symlinks, output casing,
cross-drive containment and failure cleanup.

The historical retention runs completed six crawl rounds each: 2,400 saved
resources, 72 successful retries, 240 queued cancellations, zero final reserved
bytes and confirmed worker exit. Retained parent-heap growth was 0.42–0.60 MiB;
12,000 options merges retained 18–45 KiB. These are bounded retention checks, not
throughput comparisons or exact process-memory guarantees.

Local Linux Node 24.21.0 needed an ELF-loader workaround on this WSL1 kernel.
That limitation belongs to the historical local run. The subsequently reported
Ubuntu CI pass is separate evidence for the committed code.

The earlier tarball contained 286 entries and was 202,971 bytes compressed,
943,602 bytes unpacked; its integrity and contents are recorded in the quality-pass
JSON. Those package measurements predate the fixes and must not label a new tarball.

## Guarantees and deliberate limits

The release keeps explicit crawl lifetime, bounded admission, worker task
ownership, resource-limit checks and per-crawl output conflict detection. Byte
budgets count logical body reservations, not DOMs, all temporary copies or total
RSS. Children may complete independently after a parent fails. Atomic publication
is per file and does not promise power-loss durability. Direct writes may leave
partial files; cached directory checks require a stable, trusted output tree.
Custom hooks must cooperate with cancellation, and direct custom filesystem I/O
is outside the built-in publication protocol. The migration guide defines these
contracts and their configuration options.

## Remaining release work

1. Finalize the intended allocation and markup/path changes, worker cleanup, QA harness and
   documentation in the release candidate; keep unrelated local files out of the package.
2. Complete quiet-host paired latency validation for the allocation candidate;
   include the [local MDN replay](performance.md#css-scanner-and-local-mdn-replay)
   alongside synthetic crawls. The loaded-host profiles do not establish
   non-regression. The experimental CSS scanner remains outside the release code.
   The [markup/path follow-up](performance.md#markup-and-path-follow-up-2026-10-04)
   qualifies the MDN comparison against `8c7a290`, but does not close every earlier
   or heap-pressure comparison.
3. Build and pack that exact candidate, then refresh installed-consumer and native
   Windows checks. Preserve the package digest and candidate identity together.
4. Run CI for any final code changes and record the result. The user controls CI
   and publication; the completed push did not create a tag or publish a package.

No additional performance experiment is required to reapprove the already
accepted correctness fixes. A future performance claim must respect the limits
in the current report.
