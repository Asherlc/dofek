# Data Readiness Endpoint TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation.

**Goal:** Keep the data readiness banner accurate without paying its fan-out cost on every page render.

**Behavior:** `sync.dataHealth` is reused briefly per user, hard-fails on real prerequisites/errors, and still exposes generated/freshness timestamps so clients can display freshness.

**Scope:** `sync.dataHealth` server cache, client usage, and tests. Non-goals: hiding disabled providers or changing readiness semantics.

**Docs:** `packages/server/src/routers/sync.ts`, `packages/server/src/repositories/sync-repository.ts`, web/mobile `DataReadinessBanner`.

---

## Current Evidence

- `sync.dataHealth` appears on multiple high-traffic pages across web and mobile.
- Repository freshness checks fan out across datasets and may hit both Postgres and ClickHouse.
- It is currently a plain `protectedProcedure`, unlike many dashboard routes using `cachedProtectedQuery`.

## Test Strategy

- Server unit: repeated calls reuse cache within `CacheTTL.SHORT`.
- Error tests: infrastructure/missing prerequisite errors still hard-fail.
- Client tests: banners do not render loading as a blocking state.

## File Structure

- Modify: `packages/server/src/routers/sync.ts`
- Modify: `packages/server/src/routers/sync.test.ts`
- Modify: web/mobile data readiness tests if loading display changes.

## Tasks

### Task 1: Add Failing Server Tests

- [ ] Test repeated same-user `dataHealth()` calls compute freshness once within `CacheTTL.SHORT`.
- [ ] Test different users do not share cache.
- [ ] Test errors are not cached as successful data.
- [ ] Run `rtk pnpm vitest run packages/server/src/routers/sync.test.ts --testNamePattern dataHealth --project unit`.

### Task 2: Implement Short Protected Cache

- [ ] Change `dataHealth` to `cachedProtectedQuery(CacheTTL.SHORT)`.
- [ ] Preserve current response shape and hard-failure behavior.
- [ ] Avoid warn-and-continue or stale fallback behavior.

### Task 3: Verification

- [ ] Re-run dataHealth tests.
- [ ] Run `rtk pnpm test:unit`.
- [ ] Run `rtk pnpm test:mobile` if mobile banner behavior changes.
