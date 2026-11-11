# Activity Source Tree Implementation Plan

This dated plan records the implementation steps, review checkpoints, and verification history. Checked steps describe completed work.

**Goal:** Show truthful propagation trees inside activity cards and activity detail headers on web and mobile.

**Architecture:** Project existing source members and evidence edges into a server-authored source forest. Both clients render the same contract with the primary root in an inline disclosure row and remaining nodes inside the existing card.

**Tech Stack:** TypeScript, Zod, React, React Native, Vitest, existing Storybook.

**Spec:** [Activity source tree design](../specs/2026-10-25-activity-source-tree-design.md).

## Global Constraints

- Exactly one card per activity; source expansion stays inside its border.
- Dofek is implicit. Source identities are record-specific, not provider-specific.
- Connect held records only through existing evidence; do not infer edges from matched membership or source priority.
- Both platforms use one server-authored source forest. No new dependencies, tables, read models, or environment variables.
- Keep unknown relationships visible; do not call the closest available record an established original.
- Write failing behavior tests before implementation. Work on the current branch; commit and push after required checks pass.

## Review Focus

- Repeated Apple Health copies retain distinct identities and correct parents (Task 1).
- Disconnected/cyclic/conflicting evidence never produces invented ancestry or loses records (Task 1).
- A recording source can be known without a held source record, including Strava device names (Task 1).
- Source controls never trigger activity navigation/selection and keep focus on collapse (Tasks 2 and 3).
- Map cards and unresolved-origin cards keep one coherent card at narrow widths (Tasks 2 and 3).

### Task 1: Shared source contract and server projection

**Files:** Create `packages/providers-meta/src/activity-source-tree.ts` and `packages/server/src/models/activity-source-tree.ts` with a colocated unit test. Modify `activity-source-details.ts` and its tests, shared package exports, server `activity-source-decision.ts`, calendar repository/entry/router and relevant tests.

**Interfaces:** `ActivitySourceTreeNode` has `id`, `providerId`, nullable `sourceName`, `label`, `description`, `url`, and recursive `children`. `ActivitySourceTree` has `primary: ActivitySourceTreeNode | null` and `otherSources: ActivitySourceTreeNode[]`. Export runtime Zod schemas. Add required `tree: ActivitySourceTree` to `ActivityListSourceDetail` and calendar output. Server `buildActivitySourceTree(origin, sourceLinks, evidence)` consumes existing origin, source links, and `ActivityOriginEvidence[]`.

- [x] Write failing tests for branching/repeated-provider records, disconnected components, cycle safety, deterministic ordering, tombstones, and missing upstream recordings.
- [x] Run the targeted unit suites and confirm failures for missing projection behavior.
- [x] Implement the shared schema and minimum server projection. Generalize recording attribution to source metadata from every provider. Keep copy edges exclusively evidence-based.
- [x] Select and validate `origin_evidence` in the calendar query; project the tree without an extra per-activity query.
- [x] Exercise real database-backed calendar hydration with a minimal branching fixture; do not assert SQL substrings as behavior.
- [x] Run targeted unit/integration tests, record their results, and review Task 1 for spec and quality.

### Task 2: Web disclosure inside the existing card

**Files:** Modify `packages/web/src/components/ActivitySourceDisclosure.tsx`, its unit test and story; `ActivityCardContent.tsx`, its tests/stories, and web fixtures supplying source objects.

**Interfaces:** `ActivitySourceDisclosure({ tree }: { tree: ActivitySourceTree })` renders the server contract from Task 1. `ActivityCardData.source.tree` is required.

- [x] Replace popover expectations with failing tests for collapsed/expanded inline content, distinct branches, unresolved sources, keyboard behavior, and source links.
- [x] Implement an inline disclosure; move it below the card content and map with a shared internal divider. Render the primary root once in the trigger.
- [x] Update fixtures and stories for collapsed/expanded branches and map cards. Keep navigation and selection independent.
- [x] Run relevant web unit tests; review Task 2 for spec and quality.

### Task 3: Mobile disclosure inside the existing card

**Files:** Modify `packages/mobile/components/ActivitySourceDisclosure.tsx`, its tests/stories; `app/(tabs)/activities.tsx`, corresponding route tests/stories/fixtures, and mobile source fixtures.

**Interfaces:** Same tree prop and source contract as Task 2, using native views and accessible expansion state.

- [x] Replace modal expectations with failing tests for inline expansion, branching, repeat providers, unresolved sources, and disclosure/navigation independence.
- [x] Implement the inline native disclosure and place it after the existing content/map inside the card. Preserve native touch targets and accessibility.
- [x] Update fixtures/stories; keep non-route files outside `app/`.
- [x] Run relevant mobile unit tests; review Task 3 for spec and quality.

### Task 4: Verification and delivery

**Files:** Update web/mobile README source-card guidance with citations to the implementation and WAI disclosure pattern.

- [x] Visually verify real web and mobile stories at narrow and wide widths, including both collapsed and expanded states.
- [x] Run required lint, root/server/web/mobile/shared typechecks, relevant unit suites, and required integration coverage.
- [x] Request a whole-change review and address concrete findings with regression tests.
- [x] Commit the connected feature once its interdependent contracts and checks pass, then push the current branch.
- [x] Report the user-visible outcome, checks, limitations, and a concise retrospective.

## Verification record

- Independent task reviews and the final cross-platform review cleared the graph, interaction, layout, and upgrade regressions.
- Current affected unit suites: 416 tests passed; final full mobile suite: 1,729 tests passed. The broader unit run passed 18,894 tests before the final scoped graph correction, which was rechecked in the affected suites.
- Both real Postgres/ClickHouse hydration cases passed again after the graph correction; the [retained focused run](../../incidents/2026-10-24-activity-source-validation.md#focused-calendar-hydration-passed) records both passing cases. The unchanged broad fixture setup remains limited by local ClickHouse memory, as recorded in the [incident baseline](../../production-incident-baseline.md#2026-10-24--local-activity-source-validation-exceeded-clickhouse-fixture-memory).
- Root/server/web/mobile/shared typechecks, full lint, configured Knip, production web build, and size limits passed. Browser stories verified inline expansion and keyboard behavior at phone/desktop widths.
- Review found the device-local cache contract also needed invalidation; the existing mobile cache version now discards old responses before hydration.
- Extremely deep artificial source chains remain limited by existing recursive rendering/validation; no speculative depth cap was added.
- Future checklist improvement proposed: required API response changes should review both server and device-local cache contracts. Use minimal final-schema fixtures for database hydration and real RN-web for keyboard regressions.
- PR integration retained newer activity photos, hardware, rounded logos, and the mobile query persistence opt-out. A failing regression exposed lost Garmin device thumbnails; the [tree contract](../../../packages/providers-meta/src/activity-source-tree.ts) now carries nullable logo source metadata, and both disclosures preserve exact model labels. The original four regression suites passed 83 tests after the fix; expanded integration verification passed 263 tests. An independent integration review found no further issues.
- The final merged unit/mobile run passed 20,862 tests across 1,339 files, with 19 tests skipped. Both database hydration cases, full lint, all five typechecks, spelling, configured Knip, production web build, and bundle limits passed. Narrow browser checks preserved expanded Sources below activity photos on both platforms without horizontal overflow.

## Detail-page extension

### Task 5: Detail response and cache contract

**Files:** Modify server `models/activity.ts`, `repositories/activity-repository.ts`, `repositories/activity-repository-schemas.ts`, `routers/activity.ts`, the source-tree model, calendar cache version, and their colocated tests. Extend `repositories/activity-repository.integration.test.ts` with a minimal PostgreSQL fixture. Modify mobile `lib/mobile-query-persistence.ts` and its test.

**Interfaces:** Required `ActivityDetail.sourceTree: ActivitySourceTree`; required `ActivityRow.origin_evidence: ActivityOriginEvidence[]`. Active detail SQL selects `a.origin_evidence`; fully absent detail rows explicitly return an empty evidence array. Compute the tree with `buildActivitySourceTree(activityOriginFromColumns(row), sourceLinks, row.origin_evidence)`; do not depend on nullable `sourceDecision`. Set removed source-node URLs to null and retain removal information in the description. Detail cache suffix becomes `activity-origin-source-tree-v3`; calendar source-tree cache advances to v7. Mobile persistence advances from v10 to v11.

- [x] Write failing model and real PostgreSQL tests for explicit branching evidence, single-source attribution, disconnected copies, and removed-source link suppression.
- [x] Write a failing restoration regression with a persisted v10 `activity.byId` response missing `sourceTree`; verify it is discarded before rendering.
- [x] Implement the required response, evidence selection/validation, canonical removal behavior, and cache invalidation without migrations or client-side inference.
- [x] Run affected server/cache tests and real PostgreSQL cases; review the API and upgrade behavior before delivery.

### Task 6: Web activity detail visualization

**Files:** Modify `packages/web/src/pages/ActivityDetailPage.tsx`, its unit test, and its stories.

**Interfaces:** Production `ActivityHeader` consumes required `activity.sourceTree` and renders the existing `ActivitySourceDisclosure` in place of its flat source helpers. Existing activity metrics and other detail content retain their current responsibilities.

- [x] Write failing tests for collapsed/expanded branches in the real header, duplicate provider copies, empty/unresolved trees, and removed sources without links.
- [x] Replace the flat source row with the shared disclosure; delete its unused local helpers and update required response fixtures.
- [x] Add branching collapsed/expanded detail-header stories; run affected tests/types and review the production wiring.

### Task 7: Mobile activity detail visualization and screenshots

**Files:** Create production `packages/mobile/components/activity/ActivityDetailHeader.tsx` with colocated tests and stories. Modify `app/activity/[id].tsx`, its tests under `app-tests/`, and obsolete header styles in `components/activity/styles.ts`.

**Interfaces:** `ActivityDetailHeader` accepts the existing activity identity/date/local-time/removal fields and required `sourceTree` as a typed subset of `ActivityDetail`. It renders the existing native disclosure. The route retains metrics, queries, photos, hardware, exports, and other detail logic.

- [x] Write failing component and route-wiring tests for inline expansion, distinct branches, empty/unresolved trees, source actions, and retained activity-removal notices.
- [x] Extract the existing production header and replace its flat source helpers; keep all helpers, fixtures, tests, and stories outside Expo Router's `app/` directory.
- [x] Add collapsed/expanded production header stories with the same branching sample data as web; run affected tests/types and review parity.
- [x] Capture actual web and mobile header stories in both states, verifying narrow layout and accessible actions.
- [x] Run required local checks and review the connected change.
- [x] Publish the connected change and update the PR.

Detail-page verification passed 21,015 unit/mobile tests, 347 focused server tests, 19 real PostgreSQL cases, two calendar hydration cases, 101 web detail tests, 82 mobile header/route/disclosure tests, and 27 persistence tests. Normal package/root typechecks, lint, spelling, web build/size limits, and the mobile Storybook build passed. A fresh parity review cleared the implementation after aligning the paired story captions with the server projection. New header screenshots show both disclosure states with the same source branches.
