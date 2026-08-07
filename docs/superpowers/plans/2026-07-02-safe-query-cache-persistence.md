# Safe Query Cache Persistence TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation.

**Goal:** Show last-known web and iOS data immediately after app/browser restart while preserving user privacy and freshness.

**Behavior:** Persisted server-state data restores before refetch, is scoped to the authenticated user, expires within a bounded max age, and is cleared or isolated on logout/user change.

**Scope:** TanStack Query persistence for web and mobile. Non-goals: changing server cache TTLs or changing data freshness semantics.

**Docs:** TanStack Query persistence docs, `packages/web/src/App.tsx`, `packages/mobile/app/_layout.tsx`.

---

## Current Evidence

- Web and mobile both create in-memory `QueryClient`s, so cold launches/reloads have no cached health data.
- User asked how data stays up to date, so persistence must refetch in the background and surface freshness.

## Test Strategy

- Unit/component: mock storage and prove restore-before-refetch.
- Security: prove user-scoped keys or logout clearing.
- Parity: web local storage and mobile AsyncStorage follow equivalent privacy semantics.

## File Structure

- Create: `packages/web/src/lib/query-persistence.ts`
- Create: `packages/web/src/lib/query-persistence.test.tsx`
- Create: `packages/mobile/lib/mobile-query-persistence.ts`
- Create: `packages/mobile/lib/mobile-query-persistence.test.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/mobile/app/_layout.tsx`
- Modify: package manifests and lockfile.

## Tasks

### Task 1: Add Failing Persistence Tests

- [ ] Check latest stable dependency versions before adding packages.
- [ ] Test persisted data restores before query refetch.
- [ ] Test cache is scoped by user ID or cleared on logout.
- [ ] Test max age prevents old data from restoring.
- [ ] Run `rtk pnpm vitest run packages/web/src/lib/query-persistence.test.tsx packages/mobile/lib/mobile-query-persistence.test.tsx --project unit --project mobile`.

### Task 2: Implement Persistence

- [ ] Add TanStack persistence packages and canonical storage packages.
- [ ] Use `PersistQueryClientProvider` in web and mobile provider trees.
- [ ] Configure bounded `maxAge` and compatible `gcTime`.
- [ ] Clear persisted cache on logout and user change.

### Task 3: Verification

- [ ] Run focused persistence tests.
- [ ] Run `rtk pnpm test:mobile`.
- [ ] Run `rtk pnpm test:unit`.
- [ ] Run `rtk pnpm lint`.
- [ ] Manually verify reload/force quit shows last-known data then refetches.
