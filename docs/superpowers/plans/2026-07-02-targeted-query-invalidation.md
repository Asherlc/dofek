# Targeted Query Invalidation TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation.

**Goal:** Keep data current without causing whole-app refetch storms or unrelated loading states.

**Behavior:** Sync, refresh, food writeback, and activity mutations invalidate only affected query families.

**Scope:** Web/mobile invalidation hooks and mutation success handlers. Non-goals: changing sync job behavior or backend data models.

**Docs:** `packages/web/src/hooks/useAutoSync.ts`, `packages/mobile/lib/useAutoSync.ts`, `packages/mobile/lib/useRefresh.ts`.

---

## Current Evidence

- Mobile `useAutoSync()` calls broad `trpcUtils.invalidate()` after provider and HealthKit sync.
- Mobile `useRefresh()` defaults to broad invalidation.
- Broad invalidation can blank unrelated pages and cause concurrent backend bursts.

## Test Strategy

- Unit: mocked tRPC utils prove only named families invalidate.
- Integration-style component tests: relevant screens update after mutation.

## File Structure

- Modify: `packages/web/src/hooks/useAutoSync.ts`
- Modify: `packages/web/src/hooks/useAutoSync.test.ts`
- Modify: `packages/mobile/lib/useAutoSync.ts`
- Modify: `packages/mobile/lib/useAutoSync.test.ts`
- Modify: `packages/mobile/lib/useRefresh.ts`
- Modify: `packages/mobile/lib/useRefresh.test.ts`

## Tasks

### Task 1: Add Failing Invalidation Tests

- [ ] Test web auto-sync invalidates dashboard/readiness/activity/data health families, not `utils.invalidate()`.
- [ ] Test mobile provider sync invalidates dashboard, recovery, training, activities, food, and data health families.
- [ ] Test HealthKit food writeback invalidates nutrition/food and data health families.
- [ ] Run `rtk pnpm vitest run packages/web/src/hooks/useAutoSync.test.ts packages/mobile/lib/useAutoSync.test.ts packages/mobile/lib/useRefresh.test.ts --project unit --project mobile`.

### Task 2: Implement Targeted Invalidations

- [ ] Replace broad invalidation with explicit query family invalidation.
- [ ] Keep `captureException()` on every unexpected failure path.
- [ ] Let screens opt into a local refresh callback instead of global invalidation.

### Task 3: Verification

- [ ] Re-run focused tests.
- [ ] Run `rtk pnpm test:mobile`.
- [ ] Run `rtk pnpm test:unit`.
- [ ] Manually verify refresh updates current screen without blanking unrelated tabs.
