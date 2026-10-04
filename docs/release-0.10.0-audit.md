# 0.10.0 release audit

**Implementation and functional validation are complete for `f057597`.** On
2026-10-04 the user accepted the current performance results for now and requested
no further runs. Statistical non-regression remains unproven; the uncertainty is
recorded rather than treated as a passing measurement gate. Version 0.10.0 was
unpublished when checked on 2026-10-04; this task has not published it. CI for
`f057597` passed, confirmed by the user.

Use the [migration guide](../MIGRATION-0.10.0.md) for contracts and upgrades,
[performance report](performance.md) for qualified measurements and unresolved
comparisons, and [dependency audit](dependency-audit.md) for tooling and the
mitigated upstream HTTP-cache advisory. Node **22.13.0+** is required by the package.

## Candidate and validation status

| Check | Result and scope |
| --- | --- |
| Current source: runtime `71fac26`, consumer checks `d377776`, combined in `f057597` | Linux Node 22.13.0: build, lint, strict source/test types and **548 tests / 44 suites passed** |
| Hosted CI for `f057597` | Passed, user-confirmed; Ubuntu Node 22.13.0, 22.x, 24.x and 26.x; build, tests, runtime smoke, installed declarations and smoke-only package checks |
| Installed package, Linux Node 22.13.0 | Strict declarations and **13 harnesses without log4js**, plus **two with log4js**, passed |
| Same package, native Windows Node 22.13.0 and 24.21.0 | Strict declarations and **14 harnesses without log4js**, plus **two with log4js**, passed on each version |
| Windows filesystem coverage | Both downloader modes and publication modes; encoded file URLs, cleanup, casing, drive containment and junctions; no reported harness limitations |
| Performance | Focused paired pass confirms multi buffered HTTP and multi local improvements; multi markup and earlier MDN-local show no clear difference. Five synthetic controls still fail, including in both independent repeats; user accepted the results for now and stopped further runs |
| Publication | Registry returned 404 for 0.10.0 on 2026-10-04; no publication performed |

[Closeout evidence](evidence/release-closeout.json) records source hashes, package
identity, full installed-consumer reports and the origin of the CI confirmation.
CI was not queried through the GitHub API. Its smoke-only checks are narrower than
the full local consumer runs; no full final-package Linux consumer matrix is claimed.
Documentation compaction does not change the validated source or package inputs.

The validated tarball has **291 entries**, **205,212 compressed bytes** and
**953,418 unpacked bytes**, with SHA-256:

```text
abbd0dfd01d873bf7a310832623b834a790e89b58238ce4d4dfec9484de2eb1e
```

Temporary packages, installations, runtime downloads and benchmark workspaces were
purged after preserving the closeout reports and
[cleanup manifest](evidence/cleanup-20261004.json). Raw historical
JSON remains tracked; temporary paths within it are provenance, not available
reproduction directories. Earlier full narratives remain in Git at `f057597` and
are indexed in the [experiment history](archive/0.10.0-experiments.md).
Local drafts, including `src/shared-context.ts`, remain outside the validated
snapshot and package. A release package must be built from a clean tracked checkout.

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

Performance measurement is paused by the user's acceptance of the current results.
No further benchmark run is requested. This disposition preserves all failed
controls and does not establish universal speedup or strict non-regression.

Publication remains a separate release step. If source or package inputs change,
rebuild, repack and repeat the relevant checks, recording the new candidate and
digest.

No known correctness blocker remains in this audit. This is not a universal
speedup claim or a clean dependency-advisory result; the upstream cache advisory
and built-in transport mitigation remain documented in the dependency audit.
