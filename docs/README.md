# 0.10 documentation

0.10.0 is unreleased. Start with the document matching your task:

| Task | Document |
| --- | --- |
| Install, configure or use the scraper | [Project README](../README.md) |
| Upgrade from 0.9.1 | [Migration guide](../MIGRATION-0.10.0.md) |
| Review user-visible changes | [Changelog](../CHANGELOG.md) |
| Review the 2026-10-04 release candidate's validation | [Release audit](release-0.10.0-audit.md) |
| Review the URIjs replacement and its remaining merge requirements | [URI merge-readiness audit](uri-merge-readiness.md) |
| Migrate URI hooks and understand compatibility limits | [Native URL migration](native-url-migration.md) |
| Trace URI optimization decisions and historical measurements | [URI investigation history](uri-investigation-history.md) |
| Understand measured performance and retained optimizations | [Performance](performance.md) |
| Review the 2026-10-27 property-access profiles, fixes and measured simplifications | [Object layout review](object-layout-review.md) |
| Understand dependency, parser and development-tool decisions | [Dependency audit](dependency-audit.md) |
| Opt in to GroveDOM and configure per-worker pool limits | [GroveDOM adapter](grovedom.md) |
| Continue MDN's engine migration and GroveDOM qualification | [MDN continuation](grovedom.md#mdn-ownership-migration) |

The README, migration guide and GroveDOM ownership examples describe the current
APIs, including explicit lifecycle dependencies, resource-owned documents and
input-byte limits. Dated audits and qualification tables identify the older
commit or working tree they validated; they do not validate later changes.
The [2026-10-27 review](object-layout-review.md) and
[package qualification](grovedom.md#review-follow-up-qualification-2026-10-27)
cover the follow-up committed as `3a84caa`. The dated
[2026-10-25 qualification](grovedom.md#explicit-ownership-qualification-2026-10-25)
and [layout/allocation measurements](performance.md) retain the earlier evidence.
The GroveDOM guide labels the preserved MDN patches that still use parser scopes.
Future MDN migration, replay, performance and archive/browser qualification
belong in `mdn-local`; the guide records its unchanged 0.9.1 baseline and next steps.

Earlier experiments are summarized in the [historical index](archive/0.10.0-experiments.md);
full narratives remain in Git. Their raw JSON remains in [evidence/](evidence/)
with harnesses and fingerprints. Historical measurements are not pooled or
presented as validation of a newer artifact.
