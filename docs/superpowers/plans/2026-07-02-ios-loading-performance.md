# iOS Loading Performance TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the iOS app render authenticated pages quickly by showing cached or previous data immediately, refetching in the background, and removing redundant readiness fetches from the page critical path.

**Behavior:** On cold app launch, tab navigation, and date-range changes, screens should display stable chrome and any last-known data without a blocking loading panel. Loading panels should only appear when a screen has no cached, persisted, or previous data. Background refetches may show subtle refresh state but must not blank the page.

**Scope:** Mobile query cache persistence, reusable query-loading rules, updates to the high-traffic iOS screens, targeted cache invalidation, and short server-side caching for `sync.dataHealth`. Non-goals: rewriting dashboard analytics, adding new ClickHouse/dbt models, changing visual design, or broad backend query optimization beyond the readiness endpoint.

**Docs:** Mobile app docs in `packages/mobile/README.md`; mobile agent guidance in `packages/mobile/AGENTS.md`; TanStack Query persistence docs for React Native AsyncStorage: https://github.com/tanstack/query/blob/v5.90.3/docs/framework/react/plugins/createAsyncStoragePersister.md; TanStack Query `PersistQueryClientProvider` docs: https://github.com/tanstack/query/blob/v5.90.3/docs/framework/react/plugins/persistQueryClient.md; TanStack Query v5 `placeholderData` migration docs: https://github.com/tanstack/query/blob/v5.90.3/docs/framework/react/guides/migrating-to-v5.md.

---

## Current Evidence

- `packages/mobile/app/_layout.tsx` creates an in-memory `QueryClient`, so every fresh app launch starts with an empty cache even though React Query already keeps data in memory during one app session.
- The main tabs block large parts of the page on `query.isLoading`: `packages/mobile/app/(tabs)/recovery.tsx`, `packages/mobile/app/(tabs)/strain.tsx`, `packages/mobile/app/(tabs)/activities.tsx`, `packages/mobile/app/sleep.tsx`, and parts of `packages/mobile/app/(tabs)/index.tsx`.
- `sync.dataHealth` appears on several mobile pages and is currently a plain `protectedProcedure`, while the underlying repository fans out across all data health datasets and both Postgres and ClickHouse freshness checks.
- `useRefresh()` and `useAutoSync()` can invalidate the whole tRPC query cache, which can cause unrelated pages to refetch and re-enter loading states after background sync or pull-to-refresh.
- The server already logs `mobileDashboard.dashboard`, `mobileDashboard.recovery`, and `mobileDashboard.training` timings and wraps those procedures in `cachedProtectedQuery`, so the first fix should improve mobile perceived loading and redundant readiness calls before adding deeper analytics read-model work.

## Test Strategy

- Unit: Add small tests for a reusable "blocking loading only when there is no data" helper and for query cache persistence setup behavior.
- Mobile component tests: Update tab and page tests so each screen proves it keeps rendering data while `isFetching` is true and only shows loading when `data` is absent.
- Server unit tests: Prove `sync.dataHealth` uses the shared cached protected query path or otherwise only computes freshness once per short cache window for the same user and input.
- Manual performance verification: Run the iOS app against a seeded account, capture before/after timings for cold launch to first useful content, tab switch to recovery/strain/activities/food, and pull-to-refresh. Use existing server timing logs for dashboard procedures and Sentry/OpenTelemetry breadcrumbs if available.
- UI/mobile/web parity: This is mobile-specific perceived loading work. Do not change web UI unless a shared server route contract changes; `sync.dataHealth` caching must preserve the existing API response shape for both clients.

## File Structure

- Create: `packages/mobile/lib/query-loading.ts` - shared helper for deciding whether a query should block rendering.
- Create: `packages/mobile/lib/query-loading.test.ts` - unit tests for cold loading, refetch with data, and error-with-data behavior.
- Create: `packages/mobile/lib/mobile-query-persistence.ts` - persister setup for the mobile `QueryClient`.
- Create: `packages/mobile/lib/mobile-query-persistence.test.tsx` - tests for persistence configuration and restoration behavior.
- Modify: `packages/mobile/app/_layout.tsx` - replace `QueryClientProvider` with `PersistQueryClientProvider` and wire the persister.
- Modify: `packages/mobile/app/(tabs)/index.tsx`, `recovery.tsx`, `strain.tsx`, `activities.tsx`, `food.tsx`, `packages/mobile/app/sleep.tsx`, `packages/mobile/app/providers/index.tsx`, and `packages/mobile/app/providers/[id].tsx` - use the shared loading helper and keep previous/persisted data on screen.
- Modify corresponding colocated tests under `packages/mobile/app/**` - add refetch-with-data assertions.
- Modify: `packages/mobile/lib/useRefresh.ts` and `packages/mobile/lib/useAutoSync.ts` - avoid whole-cache invalidation where a screen can invalidate only the affected query families.
- Modify: `packages/server/src/routers/sync.ts` and `packages/server/src/routers/sync.test.ts` - cache `sync.dataHealth` briefly while preserving hard failures and response shape.

## Tasks

### Task 1: Add Failing Tests For Non-Blocking Loading

**Files:**
- Create: `packages/mobile/lib/query-loading.test.ts`
- Modify: `packages/mobile/app/(tabs)/recovery.test.tsx`
- Modify: `packages/mobile/app/(tabs)/strain.test.tsx`
- Modify: `packages/mobile/app/(tabs)/activities.test.tsx`
- Modify: `packages/mobile/app/(tabs)/index.test.tsx`
- Modify: `packages/mobile/app/sleep.test.tsx`

- [ ] Write `query-loading.test.ts` expecting a helper to return `true` only when a query is initially loading and has no data.
- [ ] Add screen tests where the mocked query returns `{ data: existingData, isLoading: false, isFetching: true }` and assert existing cards/charts remain visible.
- [ ] Add screen tests where the mocked query returns `{ data: undefined, isLoading: true, isFetching: true }` and assert the existing loading state still appears.
- [ ] Run `rtk pnpm vitest run packages/mobile/lib/query-loading.test.ts packages/mobile/app/\(tabs\)/recovery.test.tsx packages/mobile/app/\(tabs\)/strain.test.tsx packages/mobile/app/\(tabs\)/activities.test.tsx packages/mobile/app/\(tabs\)/index.test.tsx packages/mobile/app/sleep.test.tsx --project mobile`.
- [ ] Confirm the tests fail because the helper does not exist and affected screens still gate too much UI on `isLoading`.

### Task 2: Implement The Minimal Mobile Loading Helper

**Files:**
- Create: `packages/mobile/lib/query-loading.ts`
- Modify: high-traffic mobile screens listed above.

- [ ] Implement `shouldShowBlockingLoading({ data, isLoading, isFetching })` with the smallest API needed by current screens.
- [ ] Replace page-level `query.isLoading` checks with the helper, keeping explicit error states that do not hide existing data unnecessarily.
- [ ] Use TanStack Query v5 `placeholderData: (previousData) => previousData` on date/window-controlled queries that do not already have it.
- [ ] Keep loading skeletons only for data-specific widgets that have no cached value yet.
- [ ] Run `rtk pnpm vitest run packages/mobile/lib/query-loading.test.ts packages/mobile/app/\(tabs\)/recovery.test.tsx packages/mobile/app/\(tabs\)/strain.test.tsx packages/mobile/app/\(tabs\)/activities.test.tsx packages/mobile/app/\(tabs\)/index.test.tsx packages/mobile/app/sleep.test.tsx --project mobile`.
- [ ] Confirm the focused mobile tests pass.

### Task 3: Persist The Mobile Query Cache Across App Restarts

**Files:**
- Create: `packages/mobile/lib/mobile-query-persistence.ts`
- Create: `packages/mobile/lib/mobile-query-persistence.test.tsx`
- Modify: `packages/mobile/app/_layout.tsx`
- Modify: `packages/mobile/package.json`
- Modify: lockfile.

- [ ] Check the latest stable versions before adding dependencies. Expected dependency family: `@tanstack/react-query-persist-client`, `@tanstack/query-async-storage-persister`, and `@react-native-async-storage/async-storage` unless the implementation finds an already-installed canonical storage package.
- [ ] Write failing tests that mock AsyncStorage restoration and assert the provider tree does not issue duplicate fetches before restore completes.
- [ ] Implement a `createMobileQueryPersister()` helper using `createAsyncStoragePersister`.
- [ ] In `_layout.tsx`, replace `QueryClientProvider` with `PersistQueryClientProvider` inside the existing `trpc.Provider`.
- [ ] Set `persistOptions.maxAge` to a bounded mobile-friendly value, such as 24 hours, and align `QueryClient` `gcTime` so restored data is not garbage-collected immediately.
- [ ] Ensure persisted data is scoped by authenticated user or cleared on logout so one user cannot see another user's cached health data.
- [ ] Run `rtk pnpm vitest run packages/mobile/lib/mobile-query-persistence.test.tsx packages/mobile/app/_layout.test.ts packages/mobile/app/_layout.cleanup.test.tsx --project mobile`.
- [ ] Confirm the focused layout/persistence tests pass.

### Task 4: Make Refresh And Auto-Sync Invalidation Targeted

**Files:**
- Modify: `packages/mobile/lib/useRefresh.ts`
- Modify: `packages/mobile/lib/useRefresh.test.ts`
- Modify: `packages/mobile/lib/useAutoSync.ts`
- Modify: `packages/mobile/lib/useAutoSync.test.ts`
- Modify calling screens only where they currently rely on whole-cache invalidation.

- [ ] Write failing tests proving pull-to-refresh for each screen invalidates the screen's query family instead of `utils.invalidate()`.
- [ ] Write failing tests proving `useAutoSync()` invalidates dashboard, data readiness, food, and activity query families explicitly instead of the whole cache.
- [ ] Implement targeted invalidation while preserving existing error reporting with `captureException()`.
- [ ] Run `rtk pnpm vitest run packages/mobile/lib/useRefresh.test.ts packages/mobile/lib/useAutoSync.test.ts --project mobile`.
- [ ] Confirm the tests pass and no unexpected catch block loses Sentry reporting.

### Task 5: Cache `sync.dataHealth` Briefly

**Files:**
- Modify: `packages/server/src/routers/sync.ts`
- Modify: `packages/server/src/routers/sync.test.ts`

- [ ] Write a failing server test showing repeated `dataHealth()` calls for the same user reuse the shared cache or call freshness computation only once within `CacheTTL.SHORT`.
- [ ] Change `dataHealth` from `protectedProcedure` to `cachedProtectedQuery(CacheTTL.SHORT)`.
- [ ] Keep the existing hard failure behavior for missing prerequisites and ClickHouse infrastructure errors; do not add warning-and-continue behavior.
- [ ] Run `rtk pnpm vitest run packages/server/src/routers/sync.test.ts --testNamePattern dataHealth --project unit`.
- [ ] Confirm data health tests pass.

### Task 6: Final Verification

- [ ] Run `rtk pnpm test:mobile`.
- [ ] Run `rtk pnpm vitest run packages/server/src/routers/sync.test.ts --testNamePattern dataHealth --project unit`.
- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm typecheck`.
- [ ] Run `rtk cd packages/mobile && pnpm typecheck`.
- [ ] On an iOS simulator or device, measure before/after:
  - Cold authenticated launch to first useful Today content.
  - Switch Today -> Recovery -> Strain -> Activities -> Food.
  - Pull-to-refresh on Today and Recovery.
  - Relaunch after force quit and confirm persisted data appears before network refetch completes.
- [ ] Review server logs for `[mobile-dashboard]` timing lines and confirm this fix improves perceived loading without hiding genuinely slow backend procedures.
- [ ] Update this plan or create a follow-up issue only if measurements show a remaining server-side bottleneck in a specific `mobileDashboard.*` procedure.
