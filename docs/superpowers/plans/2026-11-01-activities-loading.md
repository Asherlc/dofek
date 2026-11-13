# Activities Loading Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for test-first implementation and explicit review checkpoints.

**Goal:** Reduce Activities loading work on both clients without changing full-range overview totals or activity visibility.

**Architecture:** Qualify the native UUID filter in route previews. Add paged repository results and return a page envelope from `calendar.weekListV2`, retaining the released `calendar.weekList` array contract; select visible active and optional hidden rows before enriching maps. Keep the internal unpaged repository API for data-quality consumers.

**Tech Stack:** Existing TypeScript, tRPC/Zod, React/React Native, PostgreSQL, ClickHouse and Vitest; no new dependencies.

**Spec / approved direction:** The user approved both the proven query correction and server-side pagination. Preserve 20-card pages, date/type/hidden filters, multi-page selection, server visibility checks, overview totals, map status polling, previous-data rendering and actionable errors. The [incident evidence](../../production-incident-baseline.md#2026-11-01--activities-list-loading-investigation-unresolved) records the measured query cause. ClickHouse documents [alias substitution](https://clickhouse.com/docs/reference/syntax#notes-on-usage); TanStack documents [paginated query keys and previous data](https://tanstack.com/query/latest/docs/framework/react/guides/paginated-queries).

## Global Constraints

- Stay on the existing worktree/branch and push new commits automatically.
- No production writes, schema changes, concurrency tuning, retries or new dependencies.
- Execute SQL regressions against real database engines; do not assert SQL strings as behavior.
- API pagination is server-authored: `days`, `totalCount`, `page`, `pageSize`; input uses zero-based `page` and bounded `pageSize`, default 20.
- Active and hidden candidates share one stable order: local date descending, start descending, ID ascending on ties. Clamp pages after deletion. Overview input remains range/filter-only.

## Review Focus

- Visibility filtering before pagination must exclude stale/inaccessible rows without gaps.
- Hidden records must interleave with active records before selecting the page.
- Equal start times must not duplicate or drop records between pages.
- Selection across pages must retain IDs, types and hidden status for merge/delete/restore validation.
- Previous page data and errors must remain visible during fetches, and deletion of the final item must return a valid page.

### Task 1: Route preview query

**Files:** `activity-route-preview.ts` and colocated `activity-route-preview.integration.test.ts` under `packages/server/src/repositories/`.

- [x] Seed a real sorted ClickHouse fixture with requested and unrelated routes. Execute `getActivityRoutePreviews` with a row-read budget and assert the exact requested preview.
- [x] Run the regression against current code; expect a row-read-budget failure.
- [x] Qualify the UUID filter with a table alias, keeping output strings and point order.
- [x] Re-run the regression and existing route-preview tests; review the minimal diff.

### Task 2: Server pagination

**Files:** `activities-calendar-repository.ts`, `provider-absent-activities-calendar-repository.ts`, `activity-calendar-entry.ts`, `routers/calendar.ts`, and their existing tests.

**Interface:** `getPage(input: WeekListInput & { page: number; pageSize: number })` returns `{ days: CalendarDayActivities[]; totalCount: number; page: number; pageSize: number }`. Existing `getWeekList` remains available to internal range consumers.

- [x] Add failing real-database page tests for boundaries, ties, filters, hidden interleaving and page clamping; unit tests verify only selected IDs reach enrichment.
- [x] Separate candidate loading from enrichment, select the visible page, and enrich that page only. Preserve the unpaged internal call.
- [x] Add bounded pagination inputs and the page output schema to `calendar.weekListV2` with its own Redis contract; retain `calendar.weekList` for released clients.
- [x] Run focused repository/router regressions and review visibility/order/count behavior.

### Task 3: Web and mobile

**Files:** Both Activities screens and their tests/stories/fixtures; mobile query persistence and its existing upgrade test.

- [x] Add failing interaction tests that request the next server page, preserve previous content while fetching, retain cross-page selections, and use full-range overview inputs.
- [x] Consume the server envelope, remove local page slicing/counting, include page inputs only on the list query, and retain selected record metadata across pages.
- [x] Update fixtures/stories and use the new procedure key to keep persisted legacy arrays separate from page envelopes.
- [x] Run both screen suites, persistence tests and typechecks; inspect rendered screens in browser tooling where available.

### Task 4: Verify and close

- [x] Run unit/mobile tiers and relevant database suites, lint and typechecks. Record exact failures and causes if prerequisites block anything.
- [x] Review the whole diff for the five Review Focus cases; resolve functional findings with regressions.
- [x] Update the incident baseline with measured scope and validation limits, commit and push all intended changes.

## Working notes

Execution is inline in the already isolated worktree. Existing session authorization covers both changes; no additional strategy confirmation is needed. Review checkpoints follow the route query, server page contract, both clients, and the final diff.

Review checkpoint: independent review found that TanStack removes placeholder data on a failed uncached-page request. Both screens now retain the last successful query input for the same range/filters, read its data from the existing query cache, and expose Retry alongside the retained cards. Real QueryClient regressions failed before the correction and pass afterward. This uses the existing cache rather than a second copy of page data.

Validation checkpoint: route read-budget regression, focused real-database page tests, both screen suites and the initial full unit/mobile tier pass. Broad legacy calendar fixture setup fails while expanding `v_activity` in ClickHouse at its existing 1.25 GiB server cap; no memory, concurrency or timeout setting changed. Final validation details are recorded in the incident baseline.
