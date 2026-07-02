# Cross-Client Stale Data Rendering TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation.

**Goal:** Stop web and iOS pages from replacing usable existing data with full loading states during background refetches.

**Behavior:** If a query has data and is refetching, the UI keeps rendering the data and may show subtle refresh state. Blocking loading appears only when no usable data exists.

**Scope:** Loading-state helpers and high-traffic web/mobile screens. Non-goals: persistent cache storage and backend query optimization.

**Docs:** `packages/web/AGENTS.md`, `packages/mobile/AGENTS.md`, TanStack Query v5 `placeholderData` docs.

---

## Current Evidence

- Web pages pass `query.isLoading` directly into charts or replace sections in `Dashboard`, `ActivitiesPage`, `NutritionPage`, `SleepPage`, `BodyPage`, `ProviderDetailPage`, and training routes.
- Mobile tabs do the same in Today, Recovery, Strain, Activities, Food, and Sleep.
- Axiom evidence shows some long parent loads were not slow core dashboard execution, so blanking the UI can exaggerate backend waits.

## Test Strategy

- Unit: loading helper returns blocking only for no-data initial load.
- Web/mobile component tests: existing data remains visible while `isFetching`.
- Parity: same behavioral cases on both platforms.

## File Structure

- Create: `packages/web/src/lib/query-loading.ts`
- Create: `packages/web/src/lib/query-loading.test.ts`
- Create/modify: `packages/mobile/lib/query-loading.ts`
- Create/modify: `packages/mobile/lib/query-loading.test.ts`
- Modify tested web/mobile screens and tests.

## Tasks

### Task 1: Add Failing Tests

- [ ] Add helper tests for no-data loading, data refetching, error with data, and empty result.
- [ ] Add web tests for Dashboard, Activities, Nutrition, Sleep, Body, Provider Detail, and training overview.
- [ ] Add mobile tests for Today, Recovery, Strain, Activities, Food, and Sleep.
- [ ] Run `rtk pnpm vitest run packages/web/src/lib/query-loading.test.ts packages/web/src/pages/Dashboard.test.tsx packages/web/src/pages/ActivitiesPage.test.tsx packages/web/src/pages/NutritionPage.test.tsx packages/web/src/pages/SleepPage.test.tsx packages/web/src/pages/BodyPage.test.tsx packages/web/src/pages/ProviderDetailPage.test.tsx packages/web/src/routes/training/index.test.tsx --project unit`.
- [ ] Run `rtk pnpm test:mobile`.

### Task 2: Implement Minimal Policy

- [ ] Implement platform-local `shouldShowBlockingLoading`.
- [ ] Replace page-level `isLoading` gates with helper decisions.
- [ ] Add `placeholderData: (previousData) => previousData` to date/window/filter queries that blank on input changes.
- [ ] Keep errors visible without hiding existing data unless rendering would be unsafe.

### Task 3: Verification

- [ ] Re-run focused web and mobile tests.
- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm typecheck`.
- [ ] Run `rtk cd packages/web && pnpm typecheck`.
- [ ] Run `rtk cd packages/mobile && pnpm typecheck`.
