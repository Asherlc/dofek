# Activity Source Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Show truthful propagation trees inside a single expandable activity card on web and mobile.

**Architecture:** Project existing source members and evidence edges into a server-authored source forest. Both clients render the same contract with the primary root in an inline disclosure row and remaining nodes inside the existing card.

**Tech Stack:** TypeScript, Zod, React, React Native, Vitest, existing Storybook.

**Spec:** `docs/superpowers/specs/2026-10-25-activity-source-tree-design.md`

## Global Constraints

- Exactly one card per activity; source expansion stays inside its border.
- Dofek is implicit. Source identities are record-specific, not provider-specific.
- Connect held records only through existing evidence; do not infer edges from matched membership or source priority.
- Both platforms use one server-authored source forest. No new dependencies, tables, read models, or environment variables.
- Keep unknown relationships visible; do not call the closest available record an established original.
- Follow TDD. Do not switch branches. Commit and push after required checks pass.

## Review Focus

- Repeated Apple Health copies retain distinct identities and correct parents (Task 1).
- Disconnected/cyclic/conflicting evidence never produces invented ancestry or loses records (Task 1).
- A recording source can be known without a held source record, including Strava device names (Task 1).
- Source controls never trigger activity navigation/selection and keep focus on collapse (Tasks 2 and 3).
- Map cards and unresolved-origin cards keep one coherent card at narrow widths (Tasks 2 and 3).

### Task 1: Shared source contract and server projection

**Files:** Create `packages/providers-meta/src/activity-source-tree.ts` and `packages/server/src/models/activity-source-tree.ts` with a colocated unit test. Modify `activity-source-details.ts` and its tests, shared package exports, server `activity-source-decision.ts`, calendar repository/entry/router and relevant tests.

**Interfaces:** `ActivitySourceTreeNode` has `id`, `providerId`, `label`, `description`, `url`, and recursive `children`. `ActivitySourceTree` has `primary: ActivitySourceTreeNode | null` and `otherSources: ActivitySourceTreeNode[]`. Export runtime Zod schemas. Add required `tree: ActivitySourceTree` to `ActivityListSourceDetail` and calendar output. Server `buildActivitySourceTree(origin, sourceLinks, evidence)` consumes existing origin, source links, and `ActivityOriginEvidence[]`.

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

- [x] Visually verify real web and mobile stories at narrow and wide widths, including both collapsed and expanded states. Keep a quick tunnel running for each HTTP development server.
- [x] Run required lint, root/server/web/mobile/shared typechecks, relevant unit suites, and required integration coverage.
- [x] Request a whole-change review and address concrete findings with regression tests.
- [x] Commit the connected feature once its interdependent contracts and checks pass, then push the current branch automatically.
- [x] Report the user-visible outcome, checks, limitations, and a concise retrospective.

## Verification record

- Independent task reviews and the final cross-platform review cleared the graph, interaction, layout, and upgrade regressions.
- Current affected unit suites: 416 tests passed; final full mobile suite: 1,729 tests passed. The broader unit run passed 18,894 tests before the final scoped graph correction, which was rechecked in the affected suites.
- Both real Postgres/ClickHouse hydration cases passed again after the graph correction. The unchanged broad fixture setup remains limited by local ClickHouse memory, as recorded in the incident baseline.
- Root/server/web/mobile/shared typechecks, full lint, configured Knip, production web build, and size limits passed. Browser stories verified inline expansion and keyboard behavior at phone/desktop widths.
- Review found the device-local cache contract also needed invalidation; the existing mobile cache version now discards old responses before hydration.
- Extremely deep artificial source chains remain limited by existing recursive rendering/validation; no speculative depth cap was added.
- Future checklist improvement proposed: required API response changes should review both server and device-local cache contracts. Use minimal final-schema fixtures for database hydration and real RN-web for keyboard regressions.
