# Selected Activity Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users merge selected same-type activities into one persistent activity spanning their full time range on web and mobile.

**Architecture:** Keep raw provider activity rows and store the user's merge intent on the stable `activity_group`. The merge mutation moves source rows transactionally, retargets aliases, and refreshes analytics; group reconciliation treats active members of manually merged groups as connected. Existing `v_activity` group bounds provide the combined start and end.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, tRPC, React, React Native, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-activity-merge-design.md`

## Global Constraints

- Preserve every provider activity row and raw provider payload.
- Require at least two visible activities of the same canonical type.
- Retain the earliest-start group's ID and alias retired group IDs to it.
- Persist manual merge intent so later provider reconciliation keeps the group intact.
- Implement the operation on both `packages/web` and `packages/mobile`.
- Keep authorization, writes, and validation on the server; reject hidden, stale, or mixed-type selections.
- Run database-backed tests through `pnpm test:integration` or `pnpm test:all`, which use the workspace Compose wrapper.
- Commit each task and push each commit to `origin/add-activity-merge`.

## Review Focus

- Non-overlapping manual members remain in one group after reconciliation and the view spans their earliest start and latest end.
- A stale, hidden, duplicate, or cross-user selected ID cannot move rows or aliases.
- A mixed canonical activity type is rejected by the server and cannot be submitted from either client.
- Merging groups that already have aliases retargets the alias chain without cycles and old IDs resolve to the retained group.
- Analytics refresh and cache invalidation include source-member IDs and affected group IDs after a successful commit.

---

## File Map

- `src/db/schema/activity.ts`: add the durable manual merge marker to `activityGroup`.
- `drizzle/`: generated forward migration and journal entry; `docs/schema.dbml` and `docs/schema.puml` are regenerated from Drizzle.
- `src/db/activity-group-reconciliation.ts`: connect members of marked groups and preserve the marker if groups consolidate.
- `src/db/activity-group-reconciliation.integration.test.ts`: prove disjoint manual membership survives reconciliation and still spans the source times.
- `packages/server/src/repositories/activity-repository.ts`: implement transactional group reassignment and alias retargeting.
- `packages/server/src/routers/activity.ts`: expose the protected merge mutation and schedule invalidation/analytics refresh.
- `packages/server/src/routers/activity.test.ts`: verify the mutation schedules recomputation with all source-member and affected group IDs and invalidates activity/calendar caches.
- `packages/server/src/routers/activity.integration.test.ts`: exercise successful, mixed-type, stale, and duplicate selection behavior against PostgreSQL.
- `packages/web/src/pages/ActivitiesPage.tsx` and `packages/web/src/pages/ActivitiesPage.test.tsx`: add eligibility, confirmation, mutation, and refresh behavior to bulk selection.
- `packages/mobile/app/(tabs)/activities.tsx` and `packages/mobile/app-tests/(tabs)/activities.test.tsx`: matching mobile behavior and confirmation.

## Task 1: Persist manual groups through reconciliation

**Files:**
- Modify: `src/db/schema/activity.ts`
- Generate: `drizzle/0130_*.sql`, `drizzle/meta/_journal.json`, `docs/schema.dbml`, `docs/schema.puml`
- Modify: `src/db/activity-group-reconciliation.ts`
- Test: `src/db/activity-group-reconciliation.integration.test.ts`

**Interfaces:**
- Produces: `activityGroup.manualMerge`, a non-null boolean defaulting to `false`.
- Produces: reconciliation behavior that connects active members when their current group has `manual_merge = true` and carries that marker to the target when a component consolidates groups.
- Consumes: the existing per-user transaction advisory lock and alias handling in `reconcileActivityGroups()`.

- [ ] **Step 1: Write the failing integration tests** `keeps_disjoint_manually_merged_members_together_after_reconciliation` and `carries_manual_merge_marker_when_group_joins_overlap_component`. For the first, create two non-overlapping same-type records, assign them to the retained group, mark that group manually merged, and create the retired-group alias. After reconciliation, assert both source rows remain under the retained group and `fitness.v_activity` reports the minimum start and maximum end. For the second, overlap one member with another group's record and assert the final target group remains marked.
- [ ] **Step 2: Run the focused integration test and confirm the expected failure.** Run `pnpm test:integration -- src/db/activity-group-reconciliation.integration.test.ts -t keeps_disjoint_manually_merged_members_together_after_reconciliation`. Expected: FAIL because `activity_group.manual_merge` does not exist yet.
- [ ] **Step 3: Add `manualMerge` to the Drizzle group schema and generate migration `0130_activity_group_manual_merge`.** Run `pnpm generate`; keep the generated boolean non-null with `DEFAULT false` and retain the generated journal and diagram updates.
- [ ] **Step 4: Re-run the focused integration test before implementing reconciliation.** Use the command from Step 2. Expected: FAIL because the current adapter splits the now-persisted non-overlapping members.
- [ ] **Step 5: Extend reconciliation to add synthetic connections between active members of marked groups and carry the marker to a component's target group.** Preserve current overlap-only behavior for unmarked groups and keep alias flattening intact.
- [ ] **Step 6: Run the focused integration test and the reconciliation unit tests.** Run `pnpm test:integration -- src/db/activity-group-reconciliation.integration.test.ts` and `pnpm test:unit -- src/db/activity-group-reconciliation.test.ts`. Expected: both pass, including unchanged split behavior for unmarked groups.
- [ ] **Step 7: Commit and push** the schema, migration, reconciliation, diagrams, and focused tests.

## Task 2: Add the protected merge operation

**Files:**
- Modify: `packages/server/src/repositories/activity-repository.ts`
- Modify: `packages/server/src/routers/activity.ts`
- Test: `packages/server/src/routers/activity.integration.test.ts`

**Interfaces:**
- Produces: `ActivityRepository.mergeActivities(activityIds: string[])` returning `{ groupId: string; memberActivityIds: string[]; affectedGroupIds: string[] }`.
- Produces: protected `activity.merge` mutation taking `{ ids: string[] }`, with 2–500 unique UUIDs.
- Consumes: `withAccountErasureUserWriteFence`, the account-scoped advisory lock convention, existing analytics refresh queue, and activity/calendar cache invalidation.

- [ ] **Step 1: Write failing integration cases** `merges_disjoint_same_type_groups_and_flattens_aliases`, `rejects_mixed_activity_types_without_writes`, `rejects_stale_or_hidden_activity_ids_without_writes`, `rejects_cross_user_activity_ids_without_writes`, and `rejects_duplicate_activity_ids_without_writes`. Assert atomic membership/alias updates, retained ID selection by earliest start, merged `v_activity` bounds, and actionable errors. The merge case starts with an existing alias chain and verifies every retired ID targets the retained group directly.
- [ ] **Step 2: Run the focused router integration cases and confirm they fail because `activity.merge` is not implemented.** Run `pnpm test:integration -- packages/server/src/routers/activity.integration.test.ts -t 'merges_disjoint_same_type_groups_and_flattens_aliases|rejects_mixed_activity_types_without_writes|rejects_stale_or_hidden_activity_ids_without_writes|rejects_cross_user_activity_ids_without_writes|rejects_duplicate_activity_ids_without_writes'`. Expected: FAIL with the missing mutation.
- [ ] **Step 3: Implement `mergeActivities()` in `ActivityRepository`.** In one transaction, resolve every submitted ID to a visible same-user, non-hidden group; require exact unique selection coverage and matching canonical types; pick the earliest-start group with ID tie-break; move all source rows; set `manual_merge`; retarget aliases; and insert retired-group aliases. Use the same per-user advisory transaction lock as reconciliation.
- [ ] **Step 4: Add `activity.merge` and post-commit refreshes.** Validate 2–500 unique UUIDs, execute inside the account-erasure write fence, enqueue recompute refresh for all source-member and affected group IDs, invalidate activity and calendar caches, and return `{ success: true, groupId }`.
- [ ] **Step 5: Write and run the router unit test** `merge_schedules_analytics_refresh_for_every_member_and_invalidates_activity_caches` in `packages/server/src/routers/activity.test.ts`. Assert the recompute queue receives every source-member and affected group ID and the activity/calendar cache prefixes are invalidated.
- [ ] **Step 6: Run the activity router integration and unit tests.** Run `pnpm test:integration -- packages/server/src/routers/activity.integration.test.ts` and `pnpm test:unit -- packages/server/src/routers/activity.test.ts`. Expected: merge cases and existing router behavior pass.
- [ ] **Step 7: Commit and push** the repository and router implementation with its integration and unit coverage.

## Task 3: Add merge selection to web

**Files:**
- Modify: `packages/web/src/pages/ActivitiesPage.tsx`
- Test: `packages/web/src/pages/ActivitiesPage.test.tsx`

**Interfaces:**
- Consumes: `trpc.activity.merge.useMutation({ ids })` from Task 2.
- Produces: a Merge action in the existing selection controls, enabled only for at least two visible selections sharing one canonical activity type.

- [ ] **Step 1: Write failing tests** `merges_selected_same_type_activities_after_confirmation`, `disables_merge_for_fewer_than_two_or_mixed_types`, and `keeps_selection_and_displays_error_when_merge_fails`. Assert selected IDs are submitted only after confirmation and successful merges invalidate week list, activity overview, and activity list caches.
- [ ] **Step 2: Run the focused web tests and confirm the new merge action is absent.** Run `pnpm exec vitest run --project unit packages/web/src/pages/ActivitiesPage.test.tsx -t 'merges_selected_same_type_activities_after_confirmation|disables_merge_for_fewer_than_two_or_mixed_types|keeps_selection_and_displays_error_when_merge_fails'`. Expected: FAIL because merge controls do not exist.
- [ ] **Step 3: Add merge eligibility, confirmation, pending state, mutation error display, and success invalidation to `ActivitiesPage.tsx`.** Keep hidden activities ineligible and preserve the selection after server errors.
- [ ] **Step 4: Run the focused web tests and the complete `ActivitiesPage` test file.** Run `pnpm exec vitest run --project unit packages/web/src/pages/ActivitiesPage.test.tsx`. Expected: all pass.
- [ ] **Step 5: Commit and push** the web UI and its tests.

## Task 4: Add matching merge selection to mobile

**Files:**
- Modify: `packages/mobile/app/(tabs)/activities.tsx`
- Test: `packages/mobile/app-tests/(tabs)/activities.test.tsx`

**Interfaces:**
- Consumes: the same `activity.merge` mutation input and result as Task 3.
- Produces: matching same-type eligibility and an accessible native confirmation in the existing selection controls.

- [ ] **Step 1: Write failing tests** `merges_selected_same_type_activities_after_confirmation`, `disables_merge_for_fewer_than_two_or_mixed_types`, and `keeps_selection_when_merge_fails`. Assert selected IDs, all relevant cache invalidations, and error messaging.
- [ ] **Step 2: Run the focused mobile tests and confirm the new merge action is absent.** Run `pnpm test:mobile -- 'packages/mobile/app-tests/(tabs)/activities.test.tsx' -t 'merges_selected_same_type_activities_after_confirmation|disables_merge_for_fewer_than_two_or_mixed_types|keeps_selection_when_merge_fails'`. Expected: FAIL because merge controls do not exist.
- [ ] **Step 3: Add matching merge eligibility, accessible confirmation, pending state, mutation error display, and success invalidation.** Preserve selection after errors and clear it only after success or explicit cancel.
- [ ] **Step 4: Run the focused mobile tests and the complete activities test file.** Run `pnpm test:mobile -- 'packages/mobile/app-tests/(tabs)/activities.test.tsx'`. Expected: all pass.
- [ ] **Step 5: Commit and push** the mobile UI and its tests.

## Task 5: Final validation and review

**Files:** all task files above.

**Interfaces:** Task 1's marker is consumed by Task 2's mutation and reconciliation; Task 2's mutation contract is consumed unchanged by Tasks 3 and 4.

- [ ] **Step 1: Run focused database and client validation.** Run `pnpm test:integration -- src/db/activity-group-reconciliation.integration.test.ts packages/server/src/routers/activity.integration.test.ts`, `pnpm exec vitest run --project unit packages/web/src/pages/ActivitiesPage.test.tsx`, and `pnpm test:mobile -- 'packages/mobile/app-tests/(tabs)/activities.test.tsx'`. Expected: all pass.
- [ ] **Step 2: Run repository checks for the changed implementation.** Run `pnpm typecheck`, `pnpm lint:migrations`, and `pnpm exec biome check` on the changed TypeScript source and test files. Expected: all pass; migration SQL is checked by `pnpm lint:migrations`.
- [ ] **Step 3: Review the full branch against the spec and every Review Focus item.** Resolve Critical and Important findings with a failing regression test first; ledger any deferred Minor findings.
- [ ] **Step 4: Commit and push any final review fixes, then confirm the worktree is clean and all feature commits are on `origin/add-activity-merge`.**
