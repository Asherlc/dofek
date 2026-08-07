# Activity Detail Stream Hot Path TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation.

**Goal:** Prevent activity detail and stream pages from dominating ClickHouse resources.

**Behavior:** Activity detail, stream, zones, and window lookups use bounded query shapes and dbt-owned sample tables, not raw/live deduped views that scan huge ranges.

**Scope:** Activity detail/stream repositories and tests. Non-goals: changing activity dedupe semantics or UI design.

**Docs:** 2026-06-18 activity detail incident in `docs/production-incident-baseline.md`, `analytics/README.md`.

---

## Current Evidence

- Historical Axiom showed `activity.stream` logging around `121-122s` and ClickHouse reads of 14-18M location rows with `MEMORY_LIMIT_EXCEEDED`.
- Fixes moved stream reads toward `analytics.activity_location_sample`; this issue verifies no regressions and handles any current Axiom-named stream bottleneck.

## Test Strategy

- Unit: SQL shape tests assert bounded sample tables and predicates.
- Integration: real ClickHouse test only if current Axiom evidence names this path.
- UI: detail page retains previous data while stream/zones refetch.

## File Structure

- Modify: `packages/server/src/routers/activity.ts`
- Modify: activity repository/query files under `packages/server/src/repositories/`
- Modify: `packages/server/src/routers/activity.test.ts`
- Modify: `packages/web/src/pages/ActivityDetailPage.test.tsx`
- Modify: `packages/mobile/app/activity/[id].test.tsx`

## Tasks

### Task 1: Add Regression Tests

- [ ] Test `activity.stream` SQL reads bounded `analytics.activity_location_sample` or current canonical sample table.
- [ ] Test stream/window lookups include user/activity/time bounds before scanning samples.
- [ ] Test detail UI keeps activity summary visible while stream/zones refetch.
- [ ] Run `rtk pnpm vitest run packages/server/src/routers/activity.test.ts packages/web/src/pages/ActivityDetailPage.test.tsx packages/mobile/app/activity/[id].test.tsx --project unit --project mobile`.

### Task 2: Implement Only Evidence-Required Fixes

- [ ] If tests fail, fix the minimal query shape regression.
- [ ] If Axiom names a new activity bottleneck, add one query-shape test before changing SQL.
- [ ] Do not add new read models unless request-time work is proven expensive and unbounded.

### Task 3: Verification

- [ ] Re-run focused tests.
- [ ] If ClickHouse integration is needed, run `rtk docker compose up -d db redis clickhouse` and `rtk docker compose ps db redis clickhouse` first.
- [ ] Record before/after Axiom or local ClickHouse timings.
