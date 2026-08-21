# Freshness And Staleness UX TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation.

**Goal:** Make fast cached data visibly trustworthy by showing when it was generated, refreshed, or stale.

**Behavior:** Web and iOS can show last-known data immediately while clearly surfacing stale/blocked/syncing readiness state and pull-to-refresh completion.

**Scope:** Freshness display, data readiness generated time, subtle refresh state. Non-goals: recalculating metrics on clients or changing server freshness semantics.

**Docs:** `DataReadinessBanner` components, `sync.dataHealth` response, client loading plans.

---

## Current Evidence

- User explicitly asked how data stays up to date.
- `sync.dataHealth` already includes freshness fields and `generatedAt`.
- Cache persistence without freshness UI can make stale data feel misleading.

## Test Strategy

- Component tests: stale/syncing/blocked states render understandable text.
- Refresh tests: pull-to-refresh updates freshness display.
- Accessibility: timestamps and statuses are visible text, not only color.

## File Structure

- Modify: `packages/web/src/components/DataReadinessBanner.tsx`
- Modify: `packages/mobile/components/DataReadinessBanner.tsx`
- Modify colocated tests/stories.

## Tasks

### Task 1: Add Failing UX Tests

- [ ] Test generated time or "last checked" text appears when data is stale/syncing/blocked.
- [ ] Test healthy state remains quiet if product decision is to hide it.
- [ ] Test clients display server `error.message` for readiness failures.
- [ ] Run `rtk pnpm vitest run packages/web/src/components/DataReadinessBanner.test.tsx packages/mobile/components/DataReadinessBanner.test.tsx --project unit --project mobile`.

### Task 2: Implement Minimal Freshness UI

- [ ] Add layman-readable freshness text using server-provided fields.
- [ ] Keep clients rendering only; do not compute metric values client-side.
- [ ] Update Storybook stories for both platforms.

### Task 3: Verification

- [ ] Re-run focused tests.
- [ ] Run `rtk pnpm test:mobile`.
- [ ] Run `rtk pnpm test:unit`.
- [ ] Manually verify stale and healthy states.
