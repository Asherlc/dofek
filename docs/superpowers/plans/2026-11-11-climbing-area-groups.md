# Explicit Climbing Location Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group explicitly equivalent source locations on web and mobile without changing source names.

**Architecture:** Add one owner-scoped group table and an optional Area membership. Project the selected leaf membership through the existing repository and versioned contract; reuse the shared grouping helper.

**Tech Stack:** PostgreSQL, Drizzle, Zod, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-climbing-area-groups-design.md` (approved direction recorded there).

## Global Constraints

- Preserve source IDs, names, paths, maps, attempts, and explicit attachments.
- No automatic matching, editor, dependency, or custom operational CLI.
- No branch switching; use the existing isolated worktree.
- Schema-only deploy migration; production mapping is an exact-owner operator transaction after deployment.
- Use the current account-erasure discovery and fencing conventions.

## Review Focus

- Another owner's group cannot be assigned to an Area.
- Sync and renames preserve membership.
- Unmapped same-name Areas cannot bridge distinct explicit groups.
- Old strict installed clients receive no new field.
- Both effective log location and ordinary climb location resolve membership.

### Task 1: Persist and serve explicit membership

**Files:** `src/db/schema/climbing.ts`, new `drizzle/0184_climbing_area_groups.sql` and generated metadata/diagrams, `packages/server/src/repositories/climbing-activity-log-entry-repository.ts`, its existing test helper, `packages/server/src/contracts/climbing-log-contracts.ts`, `packages/training/src/climbing-log-response.ts`, their colocated tests, new `packages/server/src/repositories/climbing-area-group.integration.test.ts`.

**Interfaces:** Produces `areaGroup` table and nullable `area.groupId`; repository detail exposes optional nullable `areaGroupId`; wire version 5 includes it, versions 1–4 omit it.

- [ ] Write database regressions for shared groups with different names, effective location precedence, rename/resync preservation, cross-owner FK rejection, and erasure fencing/deletion. Write version-5 roundtrip and old-version projection tests.
- [ ] Run the new integration suite through `pnpm test:integration -- packages/server/src/repositories/climbing-area-group.integration.test.ts`; confirm missing schema/projection failures. Run contract tests and confirm unsupported version/serialization failures.
- [ ] Add the schema, generate the migration, add the stock erasure fence, and project membership with an owner-scoped join. Update the existing typed database test helper.
- [ ] Apply `pnpm migrate` locally. Run the database and contract suites, migration lint, schema diagram generation, and relevant typechecks. Expected: all pass.
- [ ] Review actual diff and commit/push the completed persistence and contract change.

### Task 2: Use explicit groups on both clients

**Files:** `packages/training/src/climbing-log-groups.ts` and its test; `packages/web/src/pages/ActivityDetailPage.tsx`, `packages/mobile/app/activity/[id].tsx` and existing route tests; existing paired climbing list stories/tests as needed; `docs/climbing-context.md`, `docs/production-incident-baseline.md`.

**Interfaces:** Consumes nullable `areaGroupId` from Task 1. Existing `groupClimbingLogEntriesByArea()` return shape and source paths remain unchanged.

- [ ] Write failing grouping tests for explicit membership across names/renames, separate explicit groups, no unmapped bridge, order and numbering. Update activity query expectations to version 5 and observe failures.
- [ ] Prioritize explicit group IDs in the current helper, excluding mapped areas from name-path ambiguity accounting. Request version 5 from both activity screens.
- [ ] Run shared grouping, contract, web/mobile activity and chart tests. Expected: all pass. Run the unit/mobile tier, lint and typechecks; document any named unrelated failure.
- [ ] Record confirmed diagnosis and unresolved Kilter API count discrepancy. Document a stock SQL operator transaction for the confirmed mapping after deployment.
- [ ] Obtain a fresh whole-diff review, address material findings test-first, then commit and push. No production deployment or source-count overwrite is part of this branch.
