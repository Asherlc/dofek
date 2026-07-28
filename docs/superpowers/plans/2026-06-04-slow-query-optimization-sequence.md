# Slow Query Optimization Sequence Implementation Plan

> **Note:** This plan uses checkbox (`- [ ]`) syntax for tracking progress. Steps should be executed sequentially and verified with the provided test commands.

**Goal:** Implement the approved slow-query optimization split as separate, testable PRs.

**Architecture:** Each PR targets one backend query family and ships with focused tests before behavior changes. Request paths should stop doing large repeated analytics work and should read compact, precomputed, cached, or narrowed data where that preserves existing API shapes.

**Tech Stack:** TypeScript, tRPC, Drizzle SQL, Vitest, ClickHouse, dbt analytics models, Axiom for post-deploy verification.

---

## PR 1: Dashboard Anomaly Path

**Goal:** Remove expensive anomaly computation from `mobileDashboard.dashboard` while preserving the dashboard response shape.

**Files:**
- Modify: `packages/server/src/routers/mobile-dashboard.ts`
- Modify: `packages/server/src/routers/mobile-dashboard.test.ts`
- Modify: `packages/mobile/app/(tabs)/index.tsx`

### Task 1: Prove Dashboard Does Not Run Anomaly Computation

- [ ] **Step 1: Write the failing test**

Modify the anomaly repository mock in `packages/server/src/routers/mobile-dashboard.test.ts` to expose a spy:

```ts
const anomalyRepositoryMock = vi.hoisted(() => ({
  check: vi.fn(),
}));

vi.mock("../repositories/anomaly-detection-repository.ts", () => ({
  AnomalyDetectionRepository: class {
    check(endDate: string) {
      return anomalyRepositoryMock.check(endDate);
    }
  },
}));
```

Add this test in `describe("mobileDashboard.dashboard", ...)`:

```ts
it("does not compute anomalies in the dashboard critical path", async () => {
  anomalyRepositoryMock.check.mockResolvedValue({
    anomalies: [{ date: "2026-03-28", metric: "Resting Heart Rate", value: 70, baselineMean: 60, baselineStddev: 3, zScore: 3.33, severity: "alert" }],
    checkedMetrics: ["resting_hr"],
  });
  const execute = vi.fn();
  execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28" })]);
  execute.mockResolvedValueOnce([]);

  const caller = createCaller({
    db: { execute },
    userId: "user-1",
    timezone: "UTC",
    sensorStore: makeSensorStore(),
  });

  const result = await caller.dashboard({ endDate: "2026-03-28" });

  expect(anomalyRepositoryMock.check).not.toHaveBeenCalled();
  expect(result.anomalies).toBeNull();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm vitest run packages/server/src/routers/mobile-dashboard.test.ts --testNamePattern "does not compute anomalies"
```

Expected: FAIL because `AnomalyDetectionRepository.check` is currently called.

- [ ] **Step 3: Implement the minimal dashboard change**

In `packages/server/src/routers/mobile-dashboard.ts`, remove the `AnomalyDetectionRepository` import and replace the anomaly block:

```ts
const anomalies = null;
```

Keep the `anomalies` field in `mobileDashboardOutputSchema` as `anomalyCheckOutputSchema.nullable()` and keep `anomalies` in the returned object.

- [ ] **Step 4: Run the focused test**

Run:

```bash
pnpm vitest run packages/server/src/routers/mobile-dashboard.test.ts --testNamePattern "does not compute anomalies"
```

Expected: PASS.

- [ ] **Step 5: Run full router test**

Run:

```bash
pnpm vitest run packages/server/src/routers/mobile-dashboard.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit PR 1**

```bash
git add packages/server/src/routers/mobile-dashboard.ts packages/server/src/routers/mobile-dashboard.test.ts
git commit -m "perf: remove anomalies from mobile dashboard critical path"
```

### Task 2: Keep Mobile Anomaly Display Non-Blocking

**Files:**
- Modify: `packages/mobile/app/(tabs)/index.tsx`
- Modify: `packages/mobile/app/(tabs)/index.test.tsx`

- [ ] **Step 1: Write the failing mobile test**

In `packages/mobile/app/(tabs)/index.test.tsx`, add a test that seeds `mobileDashboard.dashboard` with `anomalies: null` and seeds `anomalyDetection.check` with one alert. Assert the alert appears after the standalone anomaly query resolves.

Use the existing tRPC mock setup in that file and the same end date as the current dashboard tests.

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cd packages/mobile && pnpm test 'app/(tabs)/index.test.tsx' -- --run
```

Expected: FAIL because the screen currently reads anomalies from the dashboard payload.

- [ ] **Step 3: Implement the mobile query**

In `packages/mobile/app/(tabs)/index.tsx`, add:

```ts
const anomalyQuery = trpc.anomalyDetection.check.useQuery(
  { endDate },
  { staleTime: 10 * 60 * 1000 },
);
const anomalies = anomalyQuery.data ?? dashboardData?.anomalies;
```

Keep the existing rendering branch unchanged except that it reads from the new `anomalies` variable.

- [ ] **Step 4: Run mobile test**

Run:

```bash
cd packages/mobile && pnpm test 'app/(tabs)/index.test.tsx' -- --run
```

Expected: PASS.

- [ ] **Step 5: Commit mobile companion change**

```bash
git add 'packages/mobile/app/(tabs)/index.tsx' 'packages/mobile/app/(tabs)/index.test.tsx'
git commit -m "perf: load mobile anomalies outside dashboard"
```

### Task 3: PR 1 Verification

- [ ] **Step 1: Run checks**

```bash
pnpm lint
pnpm vitest run packages/server/src/routers/mobile-dashboard.test.ts
cd packages/mobile && pnpm test 'app/(tabs)/index.test.tsx' -- --run
cd packages/server && pnpm tsc --noEmit
cd packages/mobile && pnpm tsc --noEmit
```

Expected: all pass.

- [ ] **Step 2: Push branch**

```bash
git push
```

- [ ] **Step 3: Post-deploy Axiom check**

After deploy, run:

```bash
axiom query "['dofek-logs'] | where _time > ago(24h) | search 'Slow query' | search 'mobileDashboard.dashboard' | project _time, body | sort by _time desc | limit 50" -f json --no-spinner
axiom query "['dofek-logs'] | where _time > ago(24h) | search '[mobile-dashboard] dashboard timings' | project _time, body | sort by _time desc | limit 50" -f json --no-spinner
```

Expected: `mobileDashboard.dashboard` no longer shows `anomalies=...ms` in the route timing log, and slow dashboard counts drop.

---

## PR 2: Provider Records, Provider Stats, And Admin Counts

**Goal:** Stop provider/admin request paths from scanning large raw tables for list rows and counts.

**Files:**
- Modify: `packages/server/src/repositories/provider-detail-repository.ts`
- Modify: `packages/server/src/routers/provider-detail.test.ts`
- Modify: `packages/server/src/repositories/sync-repository.ts`
- Modify: `packages/server/src/repositories/sync-repository.test.ts`
- Modify: `packages/server/src/routers/admin.ts`
- Modify: `packages/server/src/routers/admin.test.ts`

### Task 1: Narrow Provider Record List Queries

- [ ] **Step 1: Write failing tests**

In `packages/server/src/routers/provider-detail.test.ts`, add tests under `describe("records")`:

```ts
it("does not select raw payload columns for activity list records", async () => {
  const mockExecute = vi.fn().mockResolvedValue([]);
  const caller = createCaller({ db: { execute: mockExecute }, userId: "user-1", timezone: "UTC" });

  await caller.records({ providerId: "strava", dataType: "activities" });

  const sqlText = extractSqlText(mockExecute.mock.calls[0][0]);
  expect(sqlText).not.toMatch(/SELECT \*/);
  expect(sqlText).not.toContain("raw");
});

it("does not select raw payload columns for metric stream list records", async () => {
  const mockExecute = vi.fn().mockResolvedValue([]);
  const caller = createCaller({ db: { execute: mockExecute }, userId: "user-1", timezone: "UTC" });

  await caller.records({ providerId: "apple_health", dataType: "metricStream" });

  const sqlText = extractSqlText(mockExecute.mock.calls[0][0]);
  expect(sqlText).not.toMatch(/SELECT \*/);
  expect(sqlText).toContain("recorded_at");
  expect(sqlText).toContain("channel");
  expect(sqlText).toContain("scalar");
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm vitest run packages/server/src/routers/provider-detail.test.ts --testNamePattern "raw payload columns"
```

Expected: FAIL because `getRecords()` currently uses `SELECT *`.

- [ ] **Step 3: Implement selected column lists**

In `packages/server/src/repositories/provider-detail-repository.ts`, add a function:

```ts
function listColumns(dataType: DataType): string {
  switch (dataType) {
    case "activities":
      return "id, started_at, activity_type, name, provider_id, external_id";
    case "metricStream":
      return "id, recorded_at, provider_id, external_id, channel, activity_id, scalar";
    case "dailyMetrics":
      return "date, provider_id, source_name, hrv, resting_hr, steps, distance_km";
    case "sleepSessions":
      return "id, started_at, ended_at, provider_id, duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes";
    case "foodEntries":
      return "id, date, provider_id, meal_type, name";
    case "healthEvents":
      return "id, start_date, end_date, provider_id, type, value, value_text, unit";
    case "nutritionDaily":
      return "date, provider_id, calories, protein_g, carbs_g, fat_g";
    case "labPanels":
      return "id, recorded_at, provider_id, name";
    case "labResults":
      return "id, recorded_at, provider_id, test_name, value, unit";
    case "journalEntries":
      return "id, date, provider_id, question, answer";
    case "bodyMeasurements":
      return "*";
  }
}
```

Use it in `getRecords()`:

```ts
const query = sql`SELECT ${sql.raw(listColumns(dataType))} FROM ${sql.raw(info.table)}
  WHERE user_id = ${this.#userId}
    AND provider_id = ${providerId}
  ORDER BY ${sql.raw(info.orderColumn)} DESC
  LIMIT ${limit}
  OFFSET ${offset}`;
```

Keep `getRecordDetail()` as full-detail.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run packages/server/src/routers/provider-detail.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/repositories/provider-detail-repository.ts packages/server/src/routers/provider-detail.test.ts
git commit -m "perf: narrow provider record list queries"
```

### Task 2: Replace Admin Live Counts With Estimated Counts

- [ ] **Step 1: Write failing test**

In `packages/server/src/routers/admin.test.ts`, add:

```ts
it("uses catalog estimates instead of live count scans for Postgres overview counts", async () => {
  const execute = vi.fn().mockResolvedValue([{ table_name: "metric_stream", row_count: "12345" }]);
  const caller = makeCaller(execute);

  await caller.overview();

  const sqlText = getSqlText(execute.mock.calls[0][0]);
  expect(sqlText).toContain("pg_class");
  expect(sqlText).toContain("reltuples");
  expect(sqlText).not.toContain("COUNT(*)");
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm vitest run packages/server/src/routers/admin.test.ts --testNamePattern "catalog estimates"
```

Expected: FAIL because overview currently uses live `COUNT(*)`.

- [ ] **Step 3: Implement estimated counts**

In `packages/server/src/routers/admin.ts`, replace the Postgres overview query with:

```ts
sql`SELECT table_name, greatest(row_count, 0)::text AS row_count
    FROM (
      SELECT c.relname AS table_name, c.reltuples::bigint AS row_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'fitness'
        AND c.relkind IN ('r', 'p', 'm')
        AND c.relname IN (
          'user_profile', 'activity', 'sleep_session', 'food_entry', 'daily_metrics',
          'sync_log', 'session', 'auth_account', 'oauth_token', 'provider', 'lab_panel',
          'journal_entry', 'breathwork_session', 'supplement', 'life_events', 'nutrient',
          'food_entry_nutrient', 'supplement_definition',
          'supplement_definition_nutrient', 'metric_stream'
        )
    ) counts
    ORDER BY row_count DESC`
```

- [ ] **Step 4: Run admin tests**

```bash
pnpm vitest run packages/server/src/routers/admin.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routers/admin.ts packages/server/src/routers/admin.test.ts
git commit -m "perf: use estimated admin table counts"
```

### Task 3: Provider Stats Read-Model Follow-Up

- [ ] **Step 1: Write failing test for compact stats source**

In `packages/server/src/repositories/sync-repository.test.ts`, add a test that asserts the ClickHouse provider stats SQL reads `analytics.provider_stats` and does not contain `postgres_fitness.metric_stream`.

- [ ] **Step 2: Verify failure**

```bash
pnpm vitest run packages/server/src/repositories/sync-repository.test.ts --testNamePattern "analytics.provider_stats"
```

Expected: FAIL because the query currently live-counts raw replicated tables.

- [ ] **Step 3: Add dbt incremental provider stats model**

Create `analytics/models/read_models/provider_stats.sql` with an incremental model keyed by `provider_id` and sourced from the same raw tables currently counted in `SyncRepository`.

- [ ] **Step 4: Update repository query**

Change `#getClickHouseProviderStats()` in `packages/server/src/repositories/sync-repository.ts` to:

```sql
SELECT
  provider_id,
  activities,
  daily_metrics,
  sleep_sessions,
  body_measurements,
  food_entries,
  health_events,
  metric_stream,
  nutrition_daily,
  lab_panels,
  lab_results,
  journal_entries
FROM analytics.provider_stats
WHERE user_id = {userId:UUID}
ORDER BY provider_id
```

- [ ] **Step 5: Run tests and analytics lint**

```bash
pnpm vitest run packages/server/src/repositories/sync-repository.test.ts
pnpm lint:analytics-sql
pnpm lint:analytics-policy
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add analytics/models/read_models/provider_stats.sql packages/server/src/repositories/sync-repository.ts packages/server/src/repositories/sync-repository.test.ts
git commit -m "perf: serve provider stats from read model"
```

---

## PR 3: Health, Recovery, Stress, And Sleep Read Models

**Goal:** Move repeated rolling health windows into compact ClickHouse/dbt models.

**Files:**
- Create: `analytics/models/read_models/daily_recovery_inputs.sql`
- Create: `analytics/models/read_models/daily_activity_load.sql`
- Create: `analytics/models/read_models/sleep_performance_inputs.sql`
- Create: `analytics/models/read_models/weekly_healthspan_inputs.sql`
- Modify: `packages/server/src/routers/recovery.ts`
- Modify: `packages/server/src/routers/recovery.test.ts`
- Modify: `packages/server/src/routers/stress.ts`
- Modify: `packages/server/src/routers/stress.test.ts`
- Modify: `packages/server/src/routers/sleep-need.ts`
- Modify: `packages/server/src/routers/sleep-need.test.ts`
- Modify: `packages/server/src/routers/healthspan-query.ts`
- Modify: `packages/server/src/routers/healthspan-query.test.ts`

### Task 1: Daily Recovery Inputs Model

- [ ] **Step 1: Write failing route test**

In `packages/server/src/routers/recovery.test.ts`, add a test for `readinessScore` that uses a mock sensor store and asserts its query string contains `analytics.daily_recovery_inputs` and does not contain `analytics.v_sleep`.

- [ ] **Step 2: Verify failure**

```bash
pnpm vitest run packages/server/src/routers/recovery.test.ts --testNamePattern "daily_recovery_inputs"
```

Expected: FAIL because `readinessScore` currently calls `fetchSleepNights()`.

- [ ] **Step 3: Add dbt model**

Create `analytics/models/read_models/daily_recovery_inputs.sql` as an incremental model with columns:

```sql
user_id, date, hrv, resting_hr, respiratory_rate, efficiency_pct,
hrv_mean_30d, hrv_sd_30d, rhr_mean_30d, rhr_sd_30d, rr_mean_30d, rr_sd_30d
```

Use existing raw sources already used by `recovery.readinessScore`: `fitness.v_daily_metrics`, resting heart-rate rows, and `analytics.v_sleep`.

- [ ] **Step 4: Update route**

Replace the `readinessScore` SQL and `fetchSleepNights()` merge with one `sensorStore.query()` against `analytics.daily_recovery_inputs` filtered by user, date range, and access window.

- [ ] **Step 5: Run tests**

```bash
pnpm vitest run packages/server/src/routers/recovery.test.ts
pnpm lint:analytics-sql
pnpm lint:analytics-policy
```

Expected: PASS.

### Task 2: Daily Activity Load Model

- [ ] **Step 1: Write failing tests**

Add tests proving `recovery.strainTarget` and `recovery.workloadRatio` query `analytics.daily_activity_load` instead of `analytics.activity_summary`.

- [ ] **Step 2: Verify failure**

```bash
pnpm vitest run packages/server/src/routers/recovery.test.ts --testNamePattern "daily_activity_load"
```

Expected: FAIL.

- [ ] **Step 3: Add model and update routes**

Create `analytics/models/read_models/daily_activity_load.sql` with:

```sql
user_id, date, daily_load, acute_load_7d, chronic_load_28d, workload_ratio
```

Change recovery load routes to read from that model.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run packages/server/src/routers/recovery.test.ts
pnpm lint:analytics-sql
pnpm lint:analytics-policy
```

Expected: PASS.

### Task 3: Sleep Performance Inputs Model

- [ ] **Step 1: Write failing sleep test**

In `packages/server/src/routers/sleep-need.test.ts`, add a `performance` test that asserts the sensor query reads `analytics.sleep_performance_inputs`.

- [ ] **Step 2: Verify failure**

```bash
pnpm vitest run packages/server/src/routers/sleep-need.test.ts --testNamePattern "sleep_performance_inputs"
```

Expected: FAIL.

- [ ] **Step 3: Add model and update route**

Create `analytics/models/read_models/sleep_performance_inputs.sql` with:

```sql
user_id, date, duration_minutes, efficiency_pct, needed_minutes, consistency_score, low_stress_score
```

Update `sleepNeed.performance` to read one latest row as-of `endDate`.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run packages/server/src/routers/sleep-need.test.ts
pnpm lint:analytics-sql
pnpm lint:analytics-policy
```

Expected: PASS.

### Task 4: Weekly Healthspan Inputs Model

- [ ] **Step 1: Write failing healthspan test**

In `packages/server/src/routers/healthspan-query.test.ts`, add a test that `fetchHealthspanRawData()` reads `analytics.weekly_healthspan_inputs` for weekly zone and healthspan inputs.

- [ ] **Step 2: Verify failure**

```bash
pnpm vitest run packages/server/src/routers/healthspan-query.test.ts --testNamePattern "weekly_healthspan_inputs"
```

Expected: FAIL.

- [ ] **Step 3: Add model and update query helper**

Create `analytics/models/read_models/weekly_healthspan_inputs.sql` with:

```sql
user_id, week_start, avg_sleep_min, bedtime_stddev_min, avg_resting_hr, avg_steps,
latest_vo2max, weekly_aerobic_min, weekly_high_intensity_min, sessions_per_week,
weight_kg, body_fat_pct
```

Update `fetchHealthspanRawData()` to aggregate from this compact model over the requested week range.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run packages/server/src/routers/healthspan-query.test.ts
pnpm lint:analytics-sql
pnpm lint:analytics-policy
```

Expected: PASS.

### Task 5: PR 3 Commit And Verification

- [ ] **Step 1: Run full affected checks**

```bash
pnpm vitest run packages/server/src/routers/recovery.test.ts packages/server/src/routers/stress.test.ts packages/server/src/routers/sleep-need.test.ts packages/server/src/routers/healthspan-query.test.ts
pnpm lint
cd packages/server && pnpm tsc --noEmit
```

Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add analytics/models/read_models packages/server/src/routers/recovery.ts packages/server/src/routers/stress.ts packages/server/src/routers/sleep-need.ts packages/server/src/routers/healthspan-query.ts packages/server/src/routers/*.test.ts
git commit -m "perf: precompute health dashboard read models"
```

---

## PR 4: Body Analytics Fetch Deduplication

**Goal:** Dedupe identical body measurement row fetches across body analytics methods.

**Files:**
- Modify: `packages/server/src/repositories/body-analytics-repository.ts`
- Modify: `packages/server/src/repositories/body-analytics-repository.test.ts`

### Task 1: Add Body Row Loader

- [ ] **Step 1: Write failing tests**

In `packages/server/src/repositories/body-analytics-repository.test.ts`, add:

```ts
it("reuses body weight rows for repeated weight analytics calls with the same input", async () => {
  const { repo, query } = makeRepository([
    { date: "2024-01-01", weight_kg: "80" },
    { date: "2024-01-02", weight_kg: "81" },
    { date: "2024-01-03", weight_kg: "82" },
    { date: "2024-01-04", weight_kg: "83" },
    { date: "2024-01-05", weight_kg: "84" },
    { date: "2024-01-06", weight_kg: "85" },
    { date: "2024-01-07", weight_kg: "86" },
  ]);

  await repo.getSmoothedWeight(90, "2024-06-01");
  await repo.getWeightPrediction(90, "2024-06-01", null);

  expect(query).toHaveBeenCalledTimes(1);
});

it("does not reuse weight-only rows for recomposition rows that require body fat", async () => {
  const { repo, query } = makeRepository([
    { date: "2024-01-01", weight_kg: "80", body_fat_pct: "20" },
  ]);

  await repo.getSmoothedWeight(90, "2024-06-01");
  await repo.getRecomposition(90, "2024-06-01");

  expect(query).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm vitest run packages/server/src/repositories/body-analytics-repository.test.ts --testNamePattern "reuses body weight rows|does not reuse"
```

Expected: first test FAILS because each method calls the store directly.

- [ ] **Step 3: Implement row cache**

Add a private cache map in `BodyAnalyticsRepository`:

```ts
readonly #bodyRowsCache = new Map<string, Promise<BodyWeightRow[]>>();
```

Add a private method:

```ts
#fetchBodyWeightRows(endDate: string, days: number, options: { requireBodyFat?: boolean } = {}) {
  const key = JSON.stringify({
    userId: this.userId,
    timezone: this.timezone,
    endDate,
    days,
    accessWindow: this.accessWindow,
    requireBodyFat: options.requireBodyFat === true,
  });
  const cached = this.#bodyRowsCache.get(key);
  if (cached) return cached;
  const promise = fetchBodyWeightRows(this.#bodyStore, this.userId, this.timezone, endDate, days, {
    ...options,
    accessWindow: this.accessWindow,
  });
  this.#bodyRowsCache.set(key, promise);
  return promise;
}
```

Use it in `getSmoothedWeight()`, `getWeightPrediction()`, `getWeightTrend()`, and `getRecomposition()`.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run packages/server/src/repositories/body-analytics-repository.test.ts
cd packages/server && pnpm tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/repositories/body-analytics-repository.ts packages/server/src/repositories/body-analytics-repository.test.ts
git commit -m "perf: reuse body analytics source rows"
```

---

## PR 5: Activity Stream Verification

**Goal:** Confirm recent activity stream optimization removed current production outliers before changing code again.

**Files:**
- Modify only if Axiom still shows current `activity.stream` slow logs.
- If no code change is needed, add a short note to `docs/production-incident-baseline.md`.

### Task 1: Verify Production Signal

- [ ] **Step 1: Query Axiom**

Run:

```bash
axiom query "['dofek-logs'] | where _time > ago(24h) | search 'Slow query' | search 'procedure=activity.stream' | project _time, body | sort by _time desc | limit 100" -f json --no-spinner
```

Expected: zero or low-count slow logs after commit `ad06f204` has been deployed.

- [ ] **Step 2: Decide outcome**

If the query returns no current material slow logs, skip code changes and document that activity stream is no longer a current top offender.

If it still returns repeated slow logs above 30 seconds, create a new focused spec for bucketed stream samples or stream tiles before implementation.

- [ ] **Step 3: Commit verification note when no code change is needed**

Append a short dated note to `docs/production-incident-baseline.md`:

```md
### Follow-up (activity stream verification)

- Date: 2026-06-04.
- Evidence: Axiom slow-query logs for `activity.stream` over the checked 24-hour window showed no repeated current outliers after the activity stream optimization in `ad06f204`.
- Outcome: No further activity-stream query change was made in this optimization batch.
```

Run:

```bash
pnpm lint
```

Commit:

```bash
git add docs/production-incident-baseline.md
git commit -m "docs: record activity stream verification"
```

---

## Final Sequence Checks

- [ ] **Step 1: Confirm no leftover worktree changes**

```bash
git status --short
```

Expected: clean after each PR branch is pushed.

- [ ] **Step 2: Confirm Axiom after each deploy**

Run the slow-query aggregation after each deployed PR:

```bash
axiom query "['dofek-logs'] | where _time > ago(24h) | search 'Slow query' | project _time, body | sort by _time desc | limit 10000" -f json --no-spinner
```

Expected: the optimized procedure family drops in count and max duration before moving to the next PR.
