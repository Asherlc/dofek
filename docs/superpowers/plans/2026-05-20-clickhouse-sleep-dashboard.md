# ClickHouse Sleep Dashboard Implementation Plan

> Follow the step-by-step checklist below and mark tasks complete using `- [ ]` syntax.

**Goal:** Remove dashboard/runtime dependence on stale `fitness.v_sleep` and read deduped sleep data from ClickHouse `analytics.v_sleep`.

**Architecture:** Keep raw sleep writes in Postgres. Treat ClickHouse `analytics.v_sleep` as the runtime deduped sleep read model and fail loudly when a route needs it without `ctx.sensorStore`. Keep Postgres only for raw `sleep_stage` rows where stage intervals are not mirrored yet.

**Tech Stack:** TypeScript, tRPC, Zod, Drizzle SQL for Postgres, `ActivitySensorStore.query()` for ClickHouse, Vitest.

---

## Task 1: Add Red Tests For ClickHouse Sleep Reads

**Files:**
- Modify: `packages/server/src/repositories/sleep-repository.test.ts`
- Modify: `packages/server/src/routers/sleep-need.test.ts`
- Modify: `packages/server/src/routers/mobile-dashboard.test.ts`

- [ ] **Step 1: Add repository tests proving list/latest sleep data comes from the sensor store**

Add tests that construct `SleepRepository` with `makeMockSensorStore()` and assert `analytics.v_sleep` appears in the ClickHouse query while `db.execute` is not called for `list()` and `getLatest()`.

- [ ] **Step 2: Add router tests proving sleep need and mobile dashboard use ClickHouse sleep rows**

Add tests that return sleep rows from `sensorStore.query()` and assert generated query strings include `analytics.v_sleep` and do not include `fitness.v_sleep`.

- [ ] **Step 3: Run red tests**

Run:

```bash
pnpm vitest packages/server/src/repositories/sleep-repository.test.ts packages/server/src/routers/sleep-need.test.ts packages/server/src/routers/mobile-dashboard.test.ts
```

Expected: FAIL because production code still queries `fitness.v_sleep`.

## Task 2: Add Shared ClickHouse Sleep Helpers

**Files:**
- Create: `packages/server/src/repositories/clickhouse-sleep-repository.ts`
- Modify: `packages/server/src/routers/test-helpers.ts`

- [ ] **Step 1: Implement helper functions**

Create helpers for one-row-per-night sleep queries over `analytics.v_sleep`, including `fetchSleepNights()`, `fetchLatestSleepNight()`, and `fetchSleepEfficiencyByDate()`.

- [ ] **Step 2: Parse query results with Zod**

Use schemas with nullable numeric fields and string dates/timestamps, matching the existing route output contracts.

## Task 3: Switch Dashboard Sleep Routes

**Files:**
- Modify: `packages/server/src/repositories/sleep-repository.ts`
- Modify: `packages/server/src/routers/sleep.ts`
- Modify: `packages/server/src/routers/sleep-need.ts`
- Modify: `packages/server/src/routers/mobile-dashboard.ts`
- Modify: `packages/server/src/routers/recovery.ts`
- Modify: `packages/server/src/routers/stress.ts`

- [ ] **Step 1: Pass `ctx.sensorStore` into `SleepRepository`**

Routes that expose sleep list/latest data should require ClickHouse for deduped sleep data.

- [ ] **Step 2: Replace `fitness.v_sleep` dashboard joins with ClickHouse helper output**

Keep daily metrics in Postgres where they already live, but fetch sleep rows from ClickHouse and combine in TypeScript or via small values CTEs.

- [ ] **Step 3: Keep stage interval reads on raw Postgres tables**

`getStages()` and `getLatestStages()` can still read `fitness.sleep_stage`, but the selected/latest sleep session should come from ClickHouse.

## Task 4: Remove Postgres Materialized View Ownership

**Files:**
- Add: `drizzle/0025_drop_v_sleep.sql`
- Delete: `drizzle/_views/02_v_sleep.sql`
- Modify docs mentioning the old Postgres materialized view.

- [ ] **Step 1: Add a forward migration that drops `fitness.v_sleep`**

Use `DROP MATERIALIZED VIEW IF EXISTS fitness.v_sleep;` with no replacement compatibility view.

- [ ] **Step 2: Remove the canonical Postgres view file**

Delete `drizzle/_views/02_v_sleep.sql` so future deploy tooling cannot recreate the materialized view.

## Task 5: Verify

**Files:**
- Modify: tests touched by the route/repository changes.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
pnpm vitest packages/server/src/repositories/sleep-repository.test.ts packages/server/src/routers/sleep-need.test.ts packages/server/src/routers/mobile-dashboard.test.ts packages/server/src/routers/recovery.test.ts packages/server/src/routers/stress.test.ts
```

- [ ] **Step 2: Search for remaining runtime references**

Run:

```bash
rg -n "fitness\\.v_sleep|REFRESH MATERIALIZED VIEW.*v_sleep" packages/server/src src drizzle docs
```

Expected: no production runtime references to `fitness.v_sleep`; historical docs/tests may mention it only when describing removal.
