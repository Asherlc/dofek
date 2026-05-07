# ClickHouse View Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all remaining derived Postgres fitness views to ClickHouse and remove Postgres view sync, refresh triggers, and runtime reads.

**Architecture:** Postgres remains the raw transactional source. ClickHouse mirrors raw dependency tables and owns `analytics.v_activity`, `analytics.v_activity_members`, `analytics.v_sleep`, `analytics.v_body_measurement`, `analytics.v_daily_metrics`, `analytics.provider_stats`, and `analytics.derived_resting_heart_rate` as refreshable materialized views. Server repositories read migrated analytics through ClickHouse stores and fail loudly when `CLICKHOUSE_URL` is missing.

**Tech Stack:** TypeScript, Drizzle, Vitest, ClickHouse refreshable materialized views, PeerDB CDC, Zod runtime parsing.

---

## File Structure

- Modify `src/db/clickhouse.ts`: add bootstrap SQL for raw mirrored tables and remaining analytics read models.
- Modify `src/db/clickhouse-migrations.ts`: add a new tracked migration that rebuilds the remaining analytics view layer in ClickHouse and waits for refreshes.
- Modify `src/db/clickhouse.test.ts` and `src/db/clickhouse-migrations.test.ts`: assert the new read models and lack of Postgres view dependencies.
- Modify `src/db/run-migrate.ts` and `src/db/run-migrate.test.ts`: remove Postgres `syncMaterializedViews()` from deploy migration.
- Delete `src/db/sync-views.ts`, `src/db/sync-views.test.ts`, `drizzle/_views/*.sql`, and `packages/server/src/routes/materialized-view-refresh.ts`.
- Delete `packages/server/src/routes/materialized-view-refresh.test.ts` with the route.
- Modify `src/db/materialized-views.ts` and `packages/server/src/lib/base-repository.ts`: remove remaining Postgres materialized-view refresh constants and helper behavior.
- Modify `packages/server/src/routers/health-kit-sync.ts`, `src/providers/whoop/provider.ts`, and their tests: remove refresh calls after ingestion.
- Create `packages/server/src/repositories/clickhouse-analytics-store.ts`: shared ClickHouse query wrapper for migrated analytics read models.
- Modify repository files that currently query `fitness.v_*`, `fitness.provider_stats`, or `fitness.derived_resting_heart_rate`.
- Modify `packages/server/src/routers/clickhouse-integration-test-helpers.ts`: sync mirrored raw test tables and refresh all analytics read models.
- Modify integration tests that manually refresh Postgres views so they refresh/sync ClickHouse test models instead.
- Modify `docs/clickhouse-metric-stream.md`, `deploy/README.md`, and `docs/production-incident-baseline.md`: document the new ownership boundary and incident follow-up.

---

### Task 1: Remove Deploy-Time Postgres View Sync

**Files:**
- Modify: `src/db/run-migrate.test.ts`
- Modify: `src/db/run-migrate.ts`
- Delete in Task 10: `src/db/sync-views.ts`

- [ ] **Step 1: Write the failing test**

In `src/db/run-migrate.test.ts`, remove the `vi.mock("./sync-views.ts", ...)` block and `syncMaterializedViews` import. Replace the existing `"syncs Postgres materialized views before ClickHouse migrations"` test with:

```ts
it("does not sync Postgres views during deploy migrations", async () => {
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
  mockRunMigrations.mockResolvedValue(0);
  mockRunClickHouseMigrations.mockResolvedValue(2);

  await main();

  expect(mockRunMigrations).toHaveBeenCalledWith("postgres://test:test@localhost:5432/test");
  expect(mockRunClickHouseMigrations).toHaveBeenCalledWith(
    clickHouseClient,
    "postgres://test:test@localhost:5432/test",
  );
  expect(mockLogger.info).not.toHaveBeenCalledWith(
    expect.stringContaining("Materialized views synced"),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test -- run src/db/run-migrate.test.ts
```

Expected: FAIL because `run-migrate.ts` still imports and calls `syncMaterializedViews()`.

- [ ] **Step 3: Write minimal implementation**

In `src/db/run-migrate.ts`, remove:

```ts
import { syncMaterializedViews } from "./sync-views.ts";
```

Remove this block from `main()`:

```ts
const viewResult = await syncMaterializedViews(databaseUrl);
logger.info(
  `[migrate] Materialized views synced=${viewResult.synced} skipped=${viewResult.skipped} refreshed=${viewResult.refreshed}`,
);
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm test -- run src/db/run-migrate.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/run-migrate.ts src/db/run-migrate.test.ts
git commit -m "Remove Postgres view sync from deploy migrations"
```

---

### Task 2: Add ClickHouse Raw Mirror Coverage

**Files:**
- Modify: `src/db/clickhouse.test.ts`
- Modify: `src/db/clickhouse.ts`
- Modify: `src/db/clickhouse-cdc.test.ts`
- Modify: `src/db/clickhouse-cdc.ts`

- [ ] **Step 1: Write the failing bootstrap test**

In `src/db/clickhouse.test.ts`, extend the bootstrap SQL test with:

```ts
expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.activity");
expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.sleep_session");
expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.sleep_stage");
expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.daily_metrics");
expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.body_measurement");
expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.provider");
expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.provider_priority");
expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.device_priority");
expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.user_profile");
```

- [ ] **Step 2: Write the failing CDC test**

In `src/db/clickhouse-cdc.test.ts`, add assertions to the mirror setup test that the generated PeerDB SQL includes all raw dependency tables:

```ts
expect(sql).toContain("'fitness.activity'");
expect(sql).toContain("'fitness.sleep_session'");
expect(sql).toContain("'fitness.sleep_stage'");
expect(sql).toContain("'fitness.daily_metrics'");
expect(sql).toContain("'fitness.body_measurement'");
expect(sql).toContain("'fitness.provider'");
expect(sql).toContain("'fitness.provider_priority'");
expect(sql).toContain("'fitness.device_priority'");
expect(sql).toContain("'fitness.user_profile'");
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
pnpm test -- run src/db/clickhouse.test.ts src/db/clickhouse-cdc.test.ts
```

Expected: FAIL because only `metric_stream` is created/mirrored for native analytics.

- [ ] **Step 4: Implement raw table DDL**

In `src/db/clickhouse.ts`, add `CREATE TABLE IF NOT EXISTS postgres_fitness.<table>` statements for each raw table. Every mirrored table must include PeerDB metadata columns:

```sql
_peerdb_synced_at DateTime64(9) DEFAULT now(),
_peerdb_is_deleted Int8 DEFAULT 0,
_peerdb_version Int64 DEFAULT 0
```

Use `MergeTree` with stable keys matching query access:

```sql
ENGINE = MergeTree
ORDER BY (user_id, started_at, id)
SETTINGS allow_nullable_key = 1
```

For non-user keyed metadata tables, use `ORDER BY provider_id` or `ORDER BY id`.

- [ ] **Step 5: Implement CDC mirror expansion**

Update the PeerDB metric stream mirror template/setup so it mirrors all required raw tables into `postgres_fitness`. The configured table list must include:

```text
fitness.metric_stream
fitness.activity
fitness.sleep_session
fitness.sleep_stage
fitness.daily_metrics
fitness.body_measurement
fitness.provider
fitness.provider_priority
fitness.device_priority
fitness.user_profile
```

- [ ] **Step 6: Run tests to verify pass**

Run:

```bash
pnpm test -- run src/db/clickhouse.test.ts src/db/clickhouse-cdc.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/clickhouse.ts src/db/clickhouse.test.ts src/db/clickhouse-cdc.ts src/db/clickhouse-cdc.test.ts src/db/peerdb
git commit -m "Mirror raw view dependencies to ClickHouse"
```

---

### Task 3: Create ClickHouse Read Models

**Files:**
- Modify: `src/db/clickhouse-migrations.test.ts`
- Modify: `src/db/clickhouse.test.ts`
- Modify: `src/db/clickhouse.ts`
- Modify: `src/db/clickhouse-migrations.ts`

- [ ] **Step 1: Write failing migration tests**

In `src/db/clickhouse-migrations.test.ts`, add:

```ts
it("creates remaining analytics read models in ClickHouse", () => {
  const sql = buildClickHouseMigrationStatements("postgres://health:fixture@db:5432/health").join(
    "\n",
  );

  expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_activity");
  expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_activity_members");
  expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_sleep");
  expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_body_measurement");
  expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_daily_metrics");
  expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.provider_stats");
  expect(sql).toContain(
    "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.derived_resting_heart_rate",
  );
  expect(sql).not.toContain("FROM postgres_fitness_live.v_daily_metrics");
  expect(sql).not.toContain("FROM postgres_fitness_live.v_sleep");
  expect(sql).not.toContain("FROM postgres_fitness_live.v_activity");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test -- run src/db/clickhouse-migrations.test.ts src/db/clickhouse.test.ts
```

Expected: FAIL because only `deduped_sensor` and `activity_summary` read models exist.

- [ ] **Step 3: Implement ClickHouse SQL builders**

In `src/db/clickhouse.ts`, split `buildClickHouseBootstrapStatementsForNativeMetricStream()` into smaller private functions:

```ts
function buildRawMirrorTableStatements(): string[] {
  return [
    "CREATE DATABASE IF NOT EXISTS postgres_fitness",
    // raw table DDL statements from Task 2
  ];
}

function buildAnalyticsReadModelStatements(): string[] {
  return [
    buildActivityReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.v_activity",
    "SYSTEM WAIT VIEW analytics.v_activity",
    buildActivityMembersReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.v_activity_members",
    "SYSTEM WAIT VIEW analytics.v_activity_members",
    buildSleepReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.v_sleep",
    "SYSTEM WAIT VIEW analytics.v_sleep",
    buildBodyMeasurementReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.v_body_measurement",
    "SYSTEM WAIT VIEW analytics.v_body_measurement",
    buildDailyMetricsReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.v_daily_metrics",
    "SYSTEM WAIT VIEW analytics.v_daily_metrics",
    buildDerivedRestingHeartRateReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.derived_resting_heart_rate",
    "SYSTEM WAIT VIEW analytics.derived_resting_heart_rate",
    buildProviderStatsReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.provider_stats",
    "SYSTEM WAIT VIEW analytics.provider_stats",
  ];
}
```

Translate each existing `drizzle/_views/*.sql` definition into ClickHouse SQL. Preserve names and output columns consumed by the server. Replace Postgres constructs as follows:

```text
DISTINCT ON -> row_number() OVER (...) plus WHERE row_number = 1
recursive cluster CTEs -> non-recursive overlap grouping where current tests define behavior
LATERAL priority lookup -> LEFT JOIN subquery with row_number by source pattern length
array_agg(DISTINCT provider_id ORDER BY provider_id) -> groupUniqArray(provider_id)
date casts -> toDate(...)
interval math -> dateDiff(...) and toInterval...
```

- [ ] **Step 4: Add a new tracked migration**

In `src/db/clickhouse-migrations.ts`, add migration id:

```ts
{
  id: "0007_remaining_postgres_views_to_clickhouse",
  statements: [
    "DROP VIEW IF EXISTS analytics.activity_summary",
    "DROP TABLE IF EXISTS analytics.activity_summary",
    "DROP VIEW IF EXISTS analytics.deduped_sensor",
    "DROP TABLE IF EXISTS analytics.deduped_sensor",
    "DROP VIEW IF EXISTS analytics.v_activity",
    "DROP TABLE IF EXISTS analytics.v_activity",
    "DROP VIEW IF EXISTS analytics.v_activity_members",
    "DROP TABLE IF EXISTS analytics.v_activity_members",
    "DROP VIEW IF EXISTS analytics.v_sleep",
    "DROP TABLE IF EXISTS analytics.v_sleep",
    "DROP VIEW IF EXISTS analytics.v_body_measurement",
    "DROP TABLE IF EXISTS analytics.v_body_measurement",
    "DROP VIEW IF EXISTS analytics.v_daily_metrics",
    "DROP TABLE IF EXISTS analytics.v_daily_metrics",
    "DROP VIEW IF EXISTS analytics.derived_resting_heart_rate",
    "DROP TABLE IF EXISTS analytics.derived_resting_heart_rate",
    "DROP VIEW IF EXISTS analytics.provider_stats",
    "DROP TABLE IF EXISTS analytics.provider_stats",
    ...buildClickHouseBootstrapStatements(postgresConnectionString),
  ],
}
```

- [ ] **Step 5: Run tests to verify pass**

Run:

```bash
pnpm test -- run src/db/clickhouse-migrations.test.ts src/db/clickhouse.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/clickhouse.ts src/db/clickhouse.test.ts src/db/clickhouse-migrations.ts src/db/clickhouse-migrations.test.ts
git commit -m "Create ClickHouse read models for fitness views"
```

---

### Task 4: Expand ClickHouse Test Sync Helpers

**Files:**
- Modify: `packages/server/src/routers/clickhouse-integration-test-helpers.ts`
- Test: `packages/server/src/routers/clickhouse-integration-test-helpers.ts` through existing integration suites

- [ ] **Step 1: Write failing helper expectations**

Add a unit-style assertion in an existing helper-adjacent test or create `packages/server/src/routers/clickhouse-integration-test-helpers.test.ts` that uses a fake client and verifies sync writes the raw mirrored tables. Use concrete expectations:

```ts
expect(commands).toContainEqual(expect.stringContaining("TRUNCATE TABLE postgres_fitness.activity"));
expect(commands).toContainEqual(expect.stringContaining("TRUNCATE TABLE postgres_fitness.sleep_session"));
expect(commands).toContainEqual(expect.stringContaining("TRUNCATE TABLE postgres_fitness.daily_metrics"));
expect(commands).toContainEqual(expect.stringContaining("SYSTEM REFRESH VIEW analytics.v_daily_metrics"));
expect(commands).toContainEqual(expect.stringContaining("SYSTEM WAIT VIEW analytics.v_daily_metrics"));
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm test -- run packages/server/src/routers/clickhouse-integration-test-helpers.test.ts
```

Expected: FAIL because the helper only syncs `metric_stream`.

- [ ] **Step 3: Implement raw table sync**

Extend `syncClickHouseTestActivitySensorStore()` to truncate and repopulate:

```text
postgres_fitness.activity
postgres_fitness.sleep_session
postgres_fitness.sleep_stage
postgres_fitness.daily_metrics
postgres_fitness.body_measurement
postgres_fitness.provider
postgres_fitness.provider_priority
postgres_fitness.device_priority
postgres_fitness.user_profile
```

Use typed row interfaces and literal helpers like `metricStreamRowValues()`. Keep empty strings out of inserted nullable values; emit `NULL` for absent values.

- [ ] **Step 4: Refresh all analytics read models**

After inserts, run:

```ts
for (const viewName of [
  "analytics.v_activity",
  "analytics.v_activity_members",
  "analytics.v_sleep",
  "analytics.v_body_measurement",
  "analytics.v_daily_metrics",
  "analytics.derived_resting_heart_rate",
  "analytics.provider_stats",
  "analytics.deduped_sensor",
  "analytics.activity_summary",
]) {
  await handle.client.command({ query: `SYSTEM REFRESH VIEW ${viewName}` });
  await handle.client.command({ query: `SYSTEM WAIT VIEW ${viewName}` });
}
```

- [ ] **Step 5: Run test to verify pass**

Run:

```bash
pnpm test -- run packages/server/src/routers/clickhouse-integration-test-helpers.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routers/clickhouse-integration-test-helpers.ts packages/server/src/routers/clickhouse-integration-test-helpers.test.ts
git commit -m "Sync ClickHouse analytics fixtures for all read models"
```

---

### Task 5: Add Shared ClickHouse Analytics Store

**Files:**
- Create: `packages/server/src/repositories/clickhouse-analytics-store.ts`
- Test: `packages/server/src/repositories/clickhouse-analytics-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/server/src/repositories/clickhouse-analytics-store.test.ts`:

```ts
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { ClickHouseAnalyticsStore } from "./clickhouse-analytics-store.ts";

describe("ClickHouseAnalyticsStore", () => {
  it("parses JSONEachRow results through the provided schema", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue([{ count: "2" }]),
      }),
    };
    const store = new ClickHouseAnalyticsStore(client);

    const rows = await store.query(
      z.object({ count: z.coerce.number() }),
      "SELECT {value:String} AS count",
      { value: "2" },
    );

    expect(rows).toEqual([{ count: 2 }]);
    expect(client.query).toHaveBeenCalledWith({
      query: "SELECT {value:String} AS count",
      format: "JSONEachRow",
      query_params: { value: "2" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm test -- run packages/server/src/repositories/clickhouse-analytics-store.test.ts
```

Expected: FAIL because the file does not exist.

- [ ] **Step 3: Implement store**

Create `packages/server/src/repositories/clickhouse-analytics-store.ts`:

```ts
import type { z } from "zod";
import type { ClickHouseQueryClient } from "./clickhouse-activity-sensor-store.ts";

export class ClickHouseAnalyticsStore {
  readonly #client: ClickHouseQueryClient;

  constructor(client: ClickHouseQueryClient) {
    this.#client = client;
  }

  async query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<z.infer<TSchema>[]> {
    const result = await this.#client.query<Record<string, unknown>>({
      query,
      format: "JSONEachRow",
      query_params: params,
    });
    const rows = await result.json();
    return rows.map((row) => schema.parse(row));
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run:

```bash
pnpm test -- run packages/server/src/repositories/clickhouse-analytics-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/repositories/clickhouse-analytics-store.ts packages/server/src/repositories/clickhouse-analytics-store.test.ts
git commit -m "Add ClickHouse analytics repository store"
```

---

### Task 6: Migrate Daily Metrics, Body, and Resting Heart Rate Reads

**Files:**
- Modify: `packages/server/src/repositories/daily-metrics-repository.ts`
- Modify: `packages/server/src/repositories/body-repository.ts`
- Modify: `packages/server/src/repositories/derived-cardio-repository.ts`
- Modify: `packages/server/src/lib/sql-fragments.ts`
- Modify corresponding tests.

- [ ] **Step 1: Write failing repository tests**

Update `packages/server/src/repositories/daily-metrics-repository.test.ts` so the mocked query text must include `analytics.v_daily_metrics` and must not include `fitness.v_daily_metrics`:

```ts
expect(queryText).toContain("analytics.v_daily_metrics");
expect(queryText).not.toContain("fitness.v_daily_metrics");
```

Add equivalent assertions for body and derived cardio repositories:

```ts
expect(queryText).toContain("analytics.v_body_measurement");
expect(queryText).toContain("analytics.derived_resting_heart_rate");
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test -- run packages/server/src/repositories/daily-metrics-repository.test.ts packages/server/src/repositories/body-repository.test.ts packages/server/src/repositories/derived-cardio-repository.integration.test.ts
```

Expected: FAIL because repositories still query Postgres views.

- [ ] **Step 3: Implement ClickHouse-backed reads**

Inject `ClickHouseAnalyticsStore` where these repositories are constructed. Replace Postgres date functions with ClickHouse equivalents:

```sql
toString(date) AS date
date > toDate({startDate:String})
date <= toDate({endDate:String})
```

For rolling HRV baseline, use:

```sql
avg(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS mean_60d
stddevPop(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS sd_60d
```

Keep Zod schemas at the repository boundary.

- [ ] **Step 4: Run tests to verify pass**

Run the same command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/repositories/daily-metrics-repository.ts packages/server/src/repositories/body-repository.ts packages/server/src/repositories/derived-cardio-repository.ts packages/server/src/lib/sql-fragments.ts packages/server/src/repositories/*.test.ts packages/server/src/repositories/*.integration.test.ts
git commit -m "Read daily health projections from ClickHouse"
```

---

### Task 7: Migrate Sleep Reads

**Files:**
- Modify: `packages/server/src/repositories/sleep-repository.ts`
- Modify: `packages/server/src/routers/sleep-need.ts`
- Modify: `packages/server/src/routers/recovery.ts`
- Modify: `packages/server/src/repositories/anomaly-detection-repository.ts`
- Modify: `packages/server/src/repositories/insights-repository.ts`
- Modify: `packages/server/src/repositories/correlation-repository.ts`
- Modify: related tests.

- [ ] **Step 1: Write failing tests**

Update sleep repository tests to assert:

```ts
expect(queryText).toContain("analytics.v_sleep");
expect(queryText).not.toContain("fitness.v_sleep");
```

Update router tests that call sleep/recovery/sleep-need paths to use `createClickHouseTestActivitySensorStore()` plus `syncClickHouseTestActivitySensorStore()` instead of `REFRESH MATERIALIZED VIEW fitness.v_sleep`.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test -- run packages/server/src/repositories/sleep-repository.test.ts packages/server/src/routers/sleep.test.ts packages/server/src/routers/sleep-need.test.ts packages/server/src/routers/recovery.test.ts
```

Expected: FAIL because code still uses `fitness.v_sleep`.

- [ ] **Step 3: Implement ClickHouse sleep reads**

Move list/latest sleep queries to `analytics.v_sleep`. Keep raw `fitness.sleep_stage` reads in Postgres only where the response requires exact stage transitions by session id. For latest stages, fetch the latest sleep window from ClickHouse first, then query raw Postgres `fitness.sleep_session` and `fitness.sleep_stage` for the overlapping stage-bearing session.

- [ ] **Step 4: Run tests to verify pass**

Run the same command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/repositories/sleep-repository.ts packages/server/src/routers/sleep-need.ts packages/server/src/routers/recovery.ts packages/server/src/repositories/anomaly-detection-repository.ts packages/server/src/repositories/insights-repository.ts packages/server/src/repositories/correlation-repository.ts packages/server/src/**/*.test.ts
git commit -m "Read sleep projections from ClickHouse"
```

---

### Task 8: Migrate Activity and Provider Stats Reads

**Files:**
- Modify: `packages/server/src/repositories/activity-repository.ts`
- Modify: `packages/server/src/repositories/calendar-repository.ts`
- Modify: `packages/server/src/repositories/training-repository.ts`
- Modify: `packages/server/src/repositories/strength-repository.ts`
- Modify: `packages/server/src/repositories/sync-repository.ts`
- Modify: `packages/server/src/routers/sync.ts`
- Modify: `packages/server/src/repositories/clickhouse-activity-sensor-store.ts`
- Modify tests.

- [ ] **Step 1: Write failing tests**

Update repository tests to assert activity reads use `analytics.v_activity`:

```ts
expect(queryText).toContain("analytics.v_activity");
expect(queryText).not.toContain("fitness.v_activity");
expect(queryText).not.toContain("postgres_fitness_live.v_activity");
```

For provider stats, assert:

```ts
expect(queryText).toContain("analytics.provider_stats");
expect(queryText).not.toContain("fitness.provider_stats");
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test -- run packages/server/src/repositories/activity-repository.test.ts packages/server/src/repositories/sync-repository.test.ts packages/server/src/routers/activity.test.ts packages/server/src/routers/sync.test.ts
```

Expected: FAIL because reads still target Postgres or `postgres_fitness_live` views.

- [ ] **Step 3: Implement ClickHouse activity/provider reads**

Replace `postgres_fitness_live.v_activity` references in ClickHouse SQL with `analytics.v_activity`. Replace `postgres_fitness_live.v_activity_members` with `analytics.v_activity_members`. Move remaining Postgres activity list/calendar/training reads to ClickHouse when they are derived-view reads; keep raw Postgres reads only for writes and direct provider detail raw-table lists.

- [ ] **Step 4: Run tests to verify pass**

Run the same command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/repositories/activity-repository.ts packages/server/src/repositories/calendar-repository.ts packages/server/src/repositories/training-repository.ts packages/server/src/repositories/strength-repository.ts packages/server/src/repositories/sync-repository.ts packages/server/src/routers/sync.ts packages/server/src/repositories/clickhouse-activity-sensor-store.ts packages/server/src/**/*.test.ts
git commit -m "Read activity projections from ClickHouse"
```

---

### Task 9: Remove Ingestion Refresh Hooks

**Files:**
- Modify: `packages/server/src/routers/health-kit-sync.ts`
- Modify: `src/providers/whoop/provider.ts`
- Modify: `src/db/materialized-views.ts`
- Modify tests.

- [ ] **Step 1: Write failing tests**

Update health-kit sync tests so existing refresh expectations become absence checks:

```ts
const refreshCalls = execute.mock.calls.filter(([query]) =>
  String(query).includes("REFRESH MATERIALIZED VIEW"),
);
expect(refreshCalls).toHaveLength(0);
```

Update WHOOP provider test:

```ts
expect(mockRefreshMaterializedView).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test -- run packages/server/src/routers/health-kit-sync.test.ts src/providers/whoop.test.ts
```

Expected: FAIL because ingestion still refreshes `fitness.v_activity` and `fitness.v_sleep`.

- [ ] **Step 3: Implement removal**

Delete `refreshIngestView()` from `packages/server/src/routers/health-kit-sync.ts` and remove its call sites. Remove `refreshMaterializedView()` usage from `src/providers/whoop/provider.ts`. Delete or empty `src/db/materialized-views.ts` only after all imports are gone.

- [ ] **Step 4: Run tests to verify pass**

Run the same command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routers/health-kit-sync.ts packages/server/src/routers/health-kit-sync.test.ts src/providers/whoop/provider.ts src/providers/whoop.test.ts src/db/materialized-views.ts
git commit -m "Remove Postgres view refresh hooks from ingestion"
```

---

### Task 10: Delete Postgres View Sync and Admin Refresh Surface

**Files:**
- Delete: `src/db/sync-views.ts`
- Delete: `src/db/sync-views.test.ts`
- Delete: `drizzle/_views/01_v_activity.sql`
- Delete: `drizzle/_views/02_v_sleep.sql`
- Delete: `drizzle/_views/03_v_body_measurement.sql`
- Delete: `drizzle/_views/04_v_daily_metrics.sql`
- Delete: `drizzle/_views/07_provider_stats.sql`
- Delete: `drizzle/_views/08_derived_resting_heart_rate.sql`
- Delete: `packages/server/src/routes/materialized-view-refresh.ts`
- Delete or modify: `packages/server/src/routes/materialized-view-refresh.test.ts`
- Modify: admin route registration files.

- [ ] **Step 1: Write failing deletion checks**

Run static searches before deletion:

```bash
rg -n "syncMaterializedViews|REFRESH MATERIALIZED VIEW|drizzle/_views|materialized-view-refresh|fitness\\.v_activity|fitness\\.v_sleep|fitness\\.v_daily_metrics|fitness\\.v_body_measurement|fitness\\.provider_stats|fitness\\.derived_resting_heart_rate" src packages scripts drizzle
```

Expected: output still lists remaining references.

- [ ] **Step 2: Delete sync files and route**

Use `apply_patch` deletes for the files listed above. Remove imports and route registration for `materialized-view-refresh`.

- [ ] **Step 3: Verify static search is clean**

Run:

```bash
rg -n "syncMaterializedViews|REFRESH MATERIALIZED VIEW|drizzle/_views|materialized-view-refresh|fitness\\.v_activity|fitness\\.v_sleep|fitness\\.v_daily_metrics|fitness\\.v_body_measurement|fitness\\.provider_stats|fitness\\.derived_resting_heart_rate" src packages scripts drizzle
```

Expected: no production-code references. Test comments may remain only if they describe the removed behavior and assert absence.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm test -- run src/db/run-migrate.test.ts packages/server/src/routes packages/server/src/routers/admin.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src packages drizzle
git commit -m "Delete Postgres view sync surface"
```

---

### Task 11: Update Integration Tests to ClickHouse Read Models

**Files:**
- Modify integration tests that currently run `REFRESH MATERIALIZED VIEW fitness.v_*`.
- Modify `src/db/dedup.integration.test.ts` or replace it with ClickHouse read-model integration tests.

- [ ] **Step 1: Convert dedup integration tests**

For each dedup test, replace direct Postgres view selects with ClickHouse helper setup:

```ts
const sensorStore = await createClickHouseTestActivitySensorStore(testCtx);
await syncClickHouseTestActivitySensorStore(testCtx);
const rows = await sensorStore.query(
  z.object({ count: z.coerce.number() }),
  `
    SELECT count() AS count
    FROM analytics.v_activity
    WHERE toDate(started_at) = toDate({date:String})
  `,
  { date: "2026-03-14" },
);
```

- [ ] **Step 2: Convert router integration tests**

Replace manual Postgres refreshes with:

```ts
const sensorStore = await createClickHouseTestActivitySensorStore(testCtx);
await syncClickHouseTestActivitySensorStore(testCtx);
```

Pass `sensorStore` through the same router context path used by existing ClickHouse activity analytics tests.

- [ ] **Step 3: Run changed integration tests**

Run:

```bash
pnpm test -- run src/db/dedup.integration.test.ts packages/server/src/routers/activity.integration.test.ts packages/server/src/routers/sleep.integration.test.ts packages/server/src/routers/daily-metrics.integration.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/dedup.integration.test.ts packages/server/src/routers/*.integration.test.ts
git commit -m "Move view integration coverage to ClickHouse"
```

---

### Task 12: Documentation and Operational Baseline

**Files:**
- Modify: `docs/clickhouse-metric-stream.md`
- Modify: `deploy/README.md`
- Modify: `docs/production-incident-baseline.md`

- [ ] **Step 1: Update ClickHouse docs**

Document that ClickHouse owns all analytics read models and list the `analytics.*` views.

- [ ] **Step 2: Update deploy README**

Remove references to Postgres materialized-view sync from deploy flow. State that deploy runs Postgres migrations, then ClickHouse migrations, then CDC setup.

- [ ] **Step 3: Update incident baseline**

Append a `2026-05-06` entry recording:

```text
Symptoms: branch deploy reached Run migrations and blocked on CREATE OR REPLACE VIEW fitness.v_daily_metrics.
Evidence: migration log stopped after "fitness.v_daily_metrics is a plain view, applying unconditionally"; pg_stat_activity showed CREATE OR REPLACE VIEW waiting on relation locks behind long-running app reads.
Root cause: deploy-time Postgres view sync attempted DDL on a hot derived view.
Fix: moved remaining derived views to ClickHouse and removed Postgres view sync/refresh paths.
Remaining risk: ClickHouse read-model refresh health now owns analytics freshness.
```

- [ ] **Step 4: Commit**

```bash
git add docs/clickhouse-metric-stream.md deploy/README.md docs/production-incident-baseline.md
git commit -m "Document ClickHouse analytics view ownership"
```

---

### Task 13: Full Verification and Branch Deploy

**Files:**
- No code changes expected unless verification finds failures.

- [ ] **Step 1: Start integration dependencies**

Run:

```bash
docker compose up -d db redis
docker compose ps db redis
```

Expected: `db` and `redis` are running. If port `5435` is occupied by another worktree, do not stop that container; record the blocker and use the testcontainers-backed suites that can still run.

- [ ] **Step 2: Run required checks**

Run:

```bash
pnpm lint
pnpm test:changed
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd ../web && pnpm tsc --noEmit
```

Expected: all commands pass.

- [ ] **Step 3: Push branch**

```bash
git push origin aloud-bike
```

- [ ] **Step 4: Dispatch branch deploy**

```bash
gh workflow run Deploy --repo Asherlc/dofek --ref aloud-bike -f target=web-stack -f refresh_materialized_views=false
```

- [ ] **Step 5: Monitor deploy**

Find and monitor the run:

```bash
gh run list --repo Asherlc/dofek --workflow Deploy --branch aloud-bike --limit 5
gh run view <run_id> --repo Asherlc/dofek --json status,conclusion,url,jobs
```

Expected: deploy succeeds. If it fails, extract the first fatal log line before changing behavior.

---

## Self-Review

Spec coverage:

- ClickHouse ownership of all six remaining projections is covered by Tasks 2 and 3.
- Server consumer migration is covered by Tasks 5 through 8.
- Removal of sync/refresh hooks is covered by Tasks 1, 9, and 10.
- Integration test migration is covered by Tasks 4 and 11.
- Documentation and incident baseline are covered by Task 12.
- Branch deploy validation is covered by Task 13.

Placeholder scan:

- The plan contains no `TBD`, `TODO`, or deferred implementation steps.
- SQL translation uses named source definitions and exact replacement rules rather than an open-ended placeholder.

Type consistency:

- `ClickHouseAnalyticsStore` uses the existing `ClickHouseQueryClient` shape.
- Test helper naming follows the existing `createClickHouseTestActivitySensorStore()` and `syncClickHouseTestActivitySensorStore()` pattern.
