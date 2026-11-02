# Metric source inheritance implementation plan

**Goal:** Show the original source logo and delivery-provider badge in both metric selectors.

**Approved design:** WHOOP via Peloton uses the same inheritance source of truth as the activity inheritance dropdown. Keep recording IDs and selection unchanged. Do not infer ancestry from provider names or hardware labels.

**Architecture:** Consume [buildActivitySourceTree](../../../packages/server/src/models/activity-source-tree.ts) and its [canonical origin evidence](../../../analytics/macros/activity_origin.sql). Project a unanimous root-to-member path into the existing metric presentation contract. Both clients render that contract.

**Review focus:** Multi-hop paths, unrelated roots, multiple member recordings, ambiguous/cyclic evidence, and device-specific labels must remain truthful.

- [x] Write regression tests for tree-derived source presentation, repository wiring, and both badge renderers; verify failures.
- [x] Read canonical ancestry alongside the owned activity window and reuse the existing tree builder; project ancestry without provider-specific detection rules.
- [x] Render provider badges on web and mobile and add stories.
- [x] Run focused tests, typechecks, formatting and broader unit/mobile checks; review the diff.

Review checkpoint: verify no provider metadata interpretation is duplicated outside the canonical origin/tree logic.

Review findings: preserve canonical model-specific labels; keep the installed mobile contract intact. The [metric-sources router](../../../packages/server/src/routers/activity.ts) defaults to response version 1 and both updated clients request version 2. Version 2 alone adds provider badges. This is a permanent versioned contract, following the repository's existing response-versioning pattern.

Verification: focused API/repository/presentation/web/mobile suites passed (483 tests), followed by all 48 shared-presentation tests after adding the unresolved-origin case. Affected package typechecks and Biome passed; the web story was visually checked in Safari. The broad suite passed 24,013 tests but captured the model-label regression during its RED phase (subsequently fixed and retested) and two unchanged PMC EWMA tests failing across today's DST transition. The PMC formula and leading-day trimming failures reproduced in isolation: their fixture uses local-date subtraction while the calculator uses UTC dates.

Retrospective: canonical evidence made the import relationship reusable without new provider inference. Independent review caught model-label loss and installed-client enum handling; retain synthetic-device and response-version fixtures for future provenance changes. The package README now records the shared-tree contract.

PR validation follow-up: corrected the [PMC test fixture](../../../packages/server/src/repositories/pmc-ewma-calculator.test.ts) to subtract UTC days consistently with its calculator; all nine PMC tests pass. Full lint passed after generating the workspace environment file so dbt used the workspace's running ClickHouse service.

CI review checkpoint: dependency-cruiser caught a type-level cycle between metric presentation and source-tree modules. Moved the ancestry projection and its tests into the shared source-tree module, keeping dependencies one-way. The exact dependency check now reports no violations, and all 185 focused source-tree/presentation/repository/router tests pass.

PR feedback checkpoint: shared ancestor chains support distinct held copies from the same delivery provider, while unlinked samples and different origins remain unresolved. The projection requires the metric row provider to match the canonical delivery provider, normalizes Apple Health aliases, and composes inherited labels with existing recorder/creator qualifiers. The mobile image mock exposes its real source URI so the selector test verifies the WHOOP PNG explicitly. Targeted behavior regressions passed RED→GREEN. Repository mutation coverage is 100% (22 killed, no survivors); no policy or resilience setting was relaxed.
