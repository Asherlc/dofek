# Cross-Client Loading Performance Phase 2 TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix slow perceived loading across web and iOS, then optimize the specific ClickHouse-backed query paths that remain slow after clients stop blanking usable data.

**Behavior:** Web and iOS should keep authenticated pages useful during background refetches, date-range changes, tab switches, and app/browser restarts. If the backend is still slow, logs and tests should identify the exact tRPC procedure and ClickHouse query family before adding or changing read models.

**Scope:** Shared loading-state policy across `packages/web` and `packages/mobile`, web query cache persistence, targeted web/mobile invalidation, `sync.dataHealth` short caching, Axiom-informed backend attribution for dashboard query families, and measured ClickHouse/dbt read-model work for proven bottlenecks. Non-goals: broad UI redesign, hiding stale data without freshness indicators, increasing bundle or size limits, adding warning-and-continue behavior, or creating new ClickHouse read models without measured Axiom/ClickHouse evidence.

**Docs:** Web docs in `packages/web/README.md`; web agent guidance in `packages/web/AGENTS.md`; mobile phase-1 plan in `docs/superpowers/plans/2026-07-02-ios-loading-performance.md`; ClickHouse/dbt analytics guidance in `analytics/README.md`; production ClickHouse dashboard incidents in `docs/production-incident-baseline.md`; TanStack Query persistence docs: https://github.com/tanstack/query/blob/v5.90.3/docs/framework/react/plugins/persistQueryClient.md; TanStack Query storage persister docs: https://github.com/tanstack/query/blob/v5.90.3/docs/framework/react/plugins/createSyncStoragePersister.md; TanStack Query v5 `placeholderData` migration docs: https://github.com/tanstack/query/blob/v5.90.3/docs/framework/react/guides/migrating-to-v5.md.

---

## Current Evidence

- Web and mobile both create in-memory `QueryClient` instances (`packages/web/src/App.tsx`, `packages/mobile/app/_layout.tsx`), so cold launches/reloads start without previous server-state data.
- Web has the same page-level loading pattern as mobile: `packages/web/src/pages/Dashboard.tsx`, `packages/web/src/pages/ActivitiesPage.tsx`, `packages/web/src/pages/NutritionPage.tsx`, `packages/web/src/pages/SleepPage.tsx`, `packages/web/src/pages/BodyPage.tsx`, `packages/web/src/pages/ProviderDetailPage.tsx`, and training routes pass `query.isLoading` directly into charts or replace sections with `QueryStatePanel`.
- `packages/web/src/lib/FetchingContext.tsx` already distinguishes empty data during a background fetch from subtle refresh state at the chart layer, but page-level and section-level loading gates do not consistently follow that policy.
- `sync.dataHealth` appears on both clients and is currently part of several high-traffic screens. Its repository implementation fans out across all readiness datasets and can query both Postgres and ClickHouse freshness.
- Historical production incidents show ClickHouse-backed dashboard routes can be real bottlenecks: dashboard batches around 19.5s, repeated dashboard query OOMs, and heavy sleep/healthspan/resting-heart-rate ClickHouse paths. Existing guidance says expensive analytics belong in incremental dbt models and named serving tables, not web/API request paths.
- Checked-in Axiom evidence from `docs/production-incident-baseline.md` on 2026-06-18 shows this is not only a query-speed problem:
  - `mobileDashboard.dashboard` was fast in the sampled 24h window: 6 spans, max `307ms`, timing logs `58-270ms`.
  - A slow mobile parent trace took `3.40s` because sibling `anomalyDetection.check` took `3.39s`, including a `3.16s` ClickHouse `POST`.
  - Web traces showed `recovery.readinessScore` max `59.44s` and `recovery.workloadRatio` max `59.33s`, while their child ClickHouse HTTP spans were only about `89-103ms`.
  - Slow-query logs in the same window showed `activity.stream` occupying the shared ClickHouse limiter for about `122s`, causing priority inversion before dashboard queries reached ClickHouse.
- Live Axiom querying should be rerun during implementation. During plan creation on 2026-07-02, `scripts/discover-axiom prod` found dataset `dofek-logs`, but even a 5-minute `take 1` query was blocked by the Axiom limiter with trace `d1c669f0d3ef8e22fe83a71eb61c4f05`.

## Test Strategy

- Unit: Add shared client loading-policy tests for "blocking only when no usable data exists" and "stale data remains visible during refetch."
- Web component tests: Prove Dashboard, Activities, Nutrition, Sleep, Body, Provider Detail, and selected training routes render existing data while `isFetching` is true.
- Mobile component tests: Reuse the phase-1 mobile tests to ensure the policy remains identical on iOS.
- Web persistence tests: Mock browser storage and verify persisted query data restores before network refetch replaces it; verify logout clears user-scoped persisted health data.
- Server unit tests: Prove `sync.dataHealth` uses short protected caching and retains hard failure behavior.
- Backend timing tests: Add tests around timing/logging helpers so slow query attribution names the procedure, queue, and subquery family without changing behavior.
- Axiom verification: Before any ClickHouse/dbt work, run fresh Axiom queries over `dofek-logs` for slow tRPC logs, `clickhouse.queue_wait`, dashboard/mobileDashboard timings, `anomalyDetection.check`, `activity.stream`, `recovery.readinessScore`, `recovery.workloadRatio`, and `sync.dataHealth`.
- Integration/manual: Use production-like seeded data, current server timing logs, and fresh Axiom aggregates to decide whether ClickHouse work is needed. Only add dbt/read-model work after identifying a named query family and a measured before/after target.
- UI/mobile/web parity: Any generic loading/freshness rule must have matching web and mobile tests. Platform-specific persistence may use different storage backends, but logout/user-scope behavior must match.

## File Structure

- Create: `packages/web/src/lib/query-loading.ts` - web helper for blocking loading decisions.
- Create: `packages/web/src/lib/query-loading.test.ts` - web helper tests.
- Create or modify: `packages/mobile/lib/query-loading.ts` and `packages/mobile/lib/query-loading.test.ts` - mobile counterpart from phase 1.
- Create: `packages/web/src/lib/query-persistence.ts` - browser persister and user-scoped cache handling.
- Create: `packages/web/src/lib/query-persistence.test.tsx` - web persistence tests.
- Modify: `packages/web/src/App.tsx` - wire `PersistQueryClientProvider` for web.
- Modify: high-traffic web pages and their tests under `packages/web/src/pages/` and `packages/web/src/routes/training/`.
- Modify: `packages/web/src/hooks/useAutoSync.ts` and tests - targeted invalidation after provider sync.
- Modify: mobile `useRefresh`/`useAutoSync` and tests if phase 1 has not already done so.
- Modify: `packages/server/src/routers/sync.ts` and `packages/server/src/routers/sync.test.ts` - short cache for `sync.dataHealth`.
- Create or modify: `packages/server/src/lib/query-timing.ts` and tests, only if existing tRPC timing cannot attribute the slow subquery family.
- Modify ClickHouse/dbt files under `analytics/models/` only after timing evidence identifies a specific route-facing bottleneck.

## Tasks

### Task 1: Refresh Axiom Baseline Before Backend Scope

**Files:**
- Modify: this plan with the fresh query results if they differ from the checked-in evidence.
- Optionally create: `.context/axiom-loading-phase-2.md` for raw query notes that should not live in docs.

- [ ] Run Axiom discovery first: `rtk "$HOME/.agents/skills/axiom-sre/scripts/discover-axiom" prod`.
- [ ] Get schema for the actual dataset before filtering fields: `rtk sh -c "printf %s \"['dofek-logs'] | getschema\" | \"$HOME/.agents/skills/axiom-sre/scripts/axiom-query\" prod --since 15m"`. If the limiter blocks it, record the trace ID in `.context/axiom-loading-phase-2.md` and ask for Axiom query access or a pasted export.
- [ ] Query recent slow tRPC logs by procedure for 24h or the largest allowed window:
  ```apl
  ['dofek-logs']
  | search "Slow query"
  | summarize count(), max(db_duration_ms), avg(db_duration_ms) by procedure
  | sort by max_db_duration_ms desc
  | limit 30
  ```
- [ ] Query dashboard queue waits:
  ```apl
  ['dofek-logs']
  | search "clickhouse.queue_wait"
  | summarize count(), max(wait_ms), avg(wait_ms), percentile(wait_ms, 95) by queue
  | sort by p95_wait_ms desc
  ```
- [ ] Query named loading suspects: `mobileDashboard.dashboard`, `anomalyDetection.check`, `activity.stream`, `recovery.readinessScore`, `recovery.workloadRatio`, `sync.dataHealth`, `sleep.latestStages`, and `healthspan.score`.
- [ ] Record exact timestamps, counts, max/average durations, and whether the evidence points to client blanking, tRPC batching, queue wait, or ClickHouse execution time.
- [ ] Do not start Task 8 ClickHouse work unless this task names a current slow backend family. If Axiom remains unavailable, keep Task 8 blocked and proceed only with client-side stale-data rendering and safe caching tasks.

### Task 2: Add Cross-Client Failing Tests For Stale Data Rendering

**Files:**
- Create: `packages/web/src/lib/query-loading.test.ts`
- Modify: `packages/web/src/pages/Dashboard.test.tsx`
- Modify: `packages/web/src/pages/ActivitiesPage.test.tsx`
- Modify: `packages/web/src/pages/NutritionPage.test.tsx`
- Modify: `packages/web/src/pages/SleepPage.test.tsx`
- Modify: `packages/web/src/pages/BodyPage.test.tsx`
- Modify: `packages/web/src/pages/ProviderDetailPage.test.tsx`
- Modify: `packages/web/src/routes/training/index.test.tsx`
- Reuse or create mobile tests from `docs/superpowers/plans/2026-07-02-ios-loading-performance.md`.

- [ ] Write web helper tests expecting blocking loading only when `data` is absent and an initial load is active.
- [ ] Add web page tests where mocked queries return existing `data`, `isLoading: false`, and `isFetching: true`; assert existing content remains visible and full loading panels are not rendered.
- [ ] Add web page tests where mocked queries return no data and `isLoading: true`; assert the existing loading skeleton/panel still appears.
- [ ] Add matching mobile tests if the phase-1 issue has not already added them.
- [ ] Run `rtk pnpm vitest run packages/web/src/lib/query-loading.test.ts packages/web/src/pages/Dashboard.test.tsx packages/web/src/pages/ActivitiesPage.test.tsx packages/web/src/pages/NutritionPage.test.tsx packages/web/src/pages/SleepPage.test.tsx packages/web/src/pages/BodyPage.test.tsx packages/web/src/pages/ProviderDetailPage.test.tsx packages/web/src/routes/training/index.test.tsx --project unit`.
- [ ] Run the matching mobile focused command from the iOS phase-1 plan.
- [ ] Confirm the tests fail because page-level loading logic still gates on `isLoading`.

### Task 3: Implement A Consistent Loading Policy On Web And Mobile

**Files:**
- Create: `packages/web/src/lib/query-loading.ts`
- Create or modify: `packages/mobile/lib/query-loading.ts`
- Modify tested web and mobile screens.

- [ ] Implement minimal platform-local helpers with the same behavior and tests. Do not introduce a new shared package unless duplication grows beyond this tiny helper.
- [ ] Replace page-level `isLoading` gates with the helper where existing data should stay visible.
- [ ] Use TanStack Query v5 `placeholderData: (previousData) => previousData` for date/window/filter queries that currently blank content on input changes.
- [ ] Keep explicit error states, but do not hide existing data for a background refetch error unless the screen cannot render safely.
- [ ] Run `rtk pnpm vitest run packages/web/src/lib/query-loading.test.ts packages/web/src/pages/Dashboard.test.tsx packages/web/src/pages/ActivitiesPage.test.tsx packages/web/src/pages/NutritionPage.test.tsx packages/web/src/pages/SleepPage.test.tsx packages/web/src/pages/BodyPage.test.tsx packages/web/src/pages/ProviderDetailPage.test.tsx packages/web/src/routes/training/index.test.tsx --project unit`.
- [ ] Run `rtk pnpm test:mobile` or the focused mobile command from phase 1.
- [ ] Confirm the focused tests pass.

### Task 4: Persist Web Query Cache Safely

**Files:**
- Create: `packages/web/src/lib/query-persistence.ts`
- Create: `packages/web/src/lib/query-persistence.test.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/package.json`
- Modify: lockfile.

- [ ] Check current latest stable versions before adding any persistence dependency. Expected dependency family: `@tanstack/react-query-persist-client` plus `@tanstack/query-sync-storage-persister`, unless the repo already has a canonical equivalent.
- [ ] Write failing tests proving cached dashboard data is restored before refetch and that persisted cache is cleared or scoped when the authenticated user changes/logs out.
- [ ] Implement browser persistence with a bounded `maxAge`, user-scoped storage key or logout clearing, and a `gcTime` that does not immediately evict restored data.
- [ ] Wire `PersistQueryClientProvider` in `packages/web/src/App.tsx`.
- [ ] Run `rtk pnpm vitest run packages/web/src/lib/query-persistence.test.tsx packages/web/src/App.test.tsx --project unit`.
- [ ] Confirm web persistence tests pass.

### Task 5: Make Web And Mobile Invalidation Targeted

**Files:**
- Modify: `packages/web/src/hooks/useAutoSync.ts`
- Modify: `packages/web/src/hooks/useAutoSync.test.ts`
- Modify: `packages/mobile/lib/useRefresh.ts`
- Modify: `packages/mobile/lib/useRefresh.test.ts`
- Modify: `packages/mobile/lib/useAutoSync.ts`
- Modify: `packages/mobile/lib/useAutoSync.test.ts`

- [ ] Write failing tests showing sync completion invalidates only dashboard/readiness/activity/food query families instead of the entire query cache.
- [ ] Implement targeted invalidation on web and mobile, preserving existing Sentry reporting in every unexpected-error path.
- [ ] Ensure provider sync, HealthKit sync, food writeback, activity mutation, and manual refresh still refresh the screens they affect.
- [ ] Run `rtk pnpm vitest run packages/web/src/hooks/useAutoSync.test.ts packages/mobile/lib/useRefresh.test.ts packages/mobile/lib/useAutoSync.test.ts --project unit --project mobile`.
- [ ] Confirm targeted invalidation tests pass.

### Task 6: Cache Shared Data Readiness Briefly

**Files:**
- Modify: `packages/server/src/routers/sync.ts`
- Modify: `packages/server/src/routers/sync.test.ts`

- [ ] Write a failing test proving repeated `sync.dataHealth` calls for the same user reuse the shared protected query cache within `CacheTTL.SHORT`.
- [ ] Change `dataHealth` to `cachedProtectedQuery(CacheTTL.SHORT)`.
- [ ] Keep hard failure semantics for missing prerequisites and infrastructure failures; do not add fallback, warning-only, or degraded data behavior.
- [ ] Run `rtk pnpm vitest run packages/server/src/routers/sync.test.ts --testNamePattern dataHealth --project unit`.
- [ ] Confirm data health tests pass.

### Task 7: Add Backend Timing Attribution Before ClickHouse Changes

**Files:**
- Prefer modifying existing logging in `packages/server/src/routers/mobile-dashboard.ts`, `packages/server/src/routers/recovery.ts`, `packages/server/src/routers/sleep.ts`, `packages/server/src/routers/daily-metrics.ts`, `packages/server/src/routers/insights.ts`, and other measured dashboard procedures only as needed.
- Create or modify: `packages/server/src/lib/query-timing.ts`
- Create or modify: `packages/server/src/lib/query-timing.test.ts`

- [ ] Write failing tests for a timing helper that records procedure, subquery family, queue name if applicable, elapsed milliseconds, `userId`, `appVersion`, and `assetsVersion` without logging raw health data.
- [ ] Add timing around dashboard subquery families only where current tRPC timing is too coarse to identify the slow ClickHouse path.
- [ ] Ensure timing fields are queryable in Axiom and match the field names discovered in Task 1.
- [ ] Run `rtk pnpm vitest run packages/server/src/lib/query-timing.test.ts packages/server/src/routers/mobile-dashboard.test.ts packages/server/src/routers/recovery.test.ts packages/server/src/routers/sleep.test.ts packages/server/src/routers/daily-metrics.test.ts --project unit`.
- [ ] Confirm the tests pass and logs contain enough attribution to decide the next ClickHouse change.

### Task 8: Only Then Optimize Proven ClickHouse Bottlenecks

**Files:**
- Modify specific `analytics/models/**` dbt models or route query files only after Task 7 identifies a named bottleneck.
- Modify corresponding server tests and analytics policy tests.

- [ ] Capture evidence for one slow query family: exact tRPC procedure, Axiom aggregate, first slow log line, ClickHouse query/log evidence, row counts or memory pressure if available, and why the current query shape is slow.
- [ ] Choose one direct fix: narrow predicates/joins in the request query, read an existing named serving table, or add an incremental dbt model if request-time work is inherently expensive.
- [ ] Write a failing test that encodes the query-shape regression, such as bounded join predicates in `JOIN ON`, reading a route-facing serving model, or avoiding raw/deduped sensor scans in a request path.
- [ ] If adding dbt SQL, make it an explicit incremental model under `analytics/models/` and keep serving table names domain/grain-specific.
- [ ] Run `rtk pnpm lint:analytics-sql`, `rtk pnpm lint:analytics-policy`, and the focused server tests for the affected route.
- [ ] If integration tests touch ClickHouse, start dependencies first with `rtk docker compose up -d db redis clickhouse` and verify them with `rtk docker compose ps db redis clickhouse`.
- [ ] Document before/after Axiom timing and memory evidence in the issue before marking this task done.

### Task 9: Final Verification

- [ ] Run `rtk pnpm test:unit`.
- [ ] Run `rtk pnpm test:mobile`.
- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm typecheck`.
- [ ] Run `rtk cd packages/web && pnpm typecheck`.
- [ ] Run `rtk cd packages/mobile && pnpm typecheck`.
- [ ] If analytics SQL changed, run `rtk pnpm analytics:build` against local ClickHouse after dependencies are up.
- [ ] Manually verify web reload, web navigation, iOS cold launch, iOS tab switches, and pull-to-refresh show last-known data first and then update.
- [ ] Compare Axiom/server timing logs before/after. If client behavior is fixed but one named ClickHouse family remains slow, create a narrower follow-up issue for that query rather than continuing broad optimization.
