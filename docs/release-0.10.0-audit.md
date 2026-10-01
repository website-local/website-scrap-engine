# 0.10.0 implementation and audit evidence

This is an unreleased implementation in progress. The release requires all
remaining gates below; passing an intermediate test run is not release approval.

## Completed foundation

- Runtime and CI minimum: Node 22.13.0; Node 24/26 coverage; publisher stays Node 24.
- Got 16 uses public `Options.toJSON()` snapshots, with `url` removed because Got
  requires it as a separate argument. Normalization does not reuse Options objects.
- Truncated responses retain content-length validation and join the bounded Got
  retry policy; explicit user error-code lists remain authoritative.
- Configuration containers and defaults are copied, preserving opaque objects and
  function identities. Runtime resource URI fields are required; normalization
  repairs stale or structured-cloned instances.
- Nested cloneable metadata survives transport; unsupported metadata fails rather
  than disappearing. DOMs are excluded.
- Build and 280 tests passed on Node 24.18.0. Runtime checks also target the exact
  minimum before the foundation commit.

`node --expose-gc scripts/benchmark-options.mjs` exercises 12,000 merges and checks
that hooks do not multiply, snapshots stay plain, and retained heap plateaus.
An optional argument accepts Got 13's `dist/source/core/options.js` to reproduce
issue #1112. The original reuse pattern retained 1,000 `_init` entries after
1,000 merges; the public-snapshot path had no growing retained heap after warm-up.
Raw local measurements are under `artifacts/wse-010-implementation/`.

## Remaining implementation and release gates

- Explicit start, cancel-and-await disposal, crawl-owned services, and isolation.
- Validated/versioned worker protocol, initialized readiness, deadlines, failures,
  message ownership, and complete cleanup.
- Safe staged publication for all sources, uniform existing-file policy, path and
  symlink containment, resource registry/outcomes, and configured admission budgets.
- Evidence-led test-runner comparison; audit TypeScript 7 without forcing an
  unsupported compiler/API migration.
- Clean-install graph/size report for development, ordinary consumers, and consumers
  without optional dependencies. Preserve the Undici size rationale and distinguish
  repository overrides from consumer installations.
- Balanced benchmarks, leak and worker stress tests, and measured optimizations.
- Packed-package/declaration checks on Node 22.13/22/24/26, complete migration notes,
  and final requirement-by-requirement verification. No tag or publication.
