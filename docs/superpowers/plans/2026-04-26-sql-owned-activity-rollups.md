# SQL-Owned Activity Rollups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a SQL-owned derived activity rollup layer that speeds up current app analytics while keeping `fitness.*` as the raw source of truth.

**Architecture:** Add a separate `analytics` schema with rebuildable projection tables and SQL refresh functions. Postgres owns the derived math; TypeScript only drains dirty work and existing app routers read the projection where it directly replaces current expensive queries. This does not replace raw `metric_stream`, `deduped_sensor`, or activity detail streams.

**Tech Stack:** PostgreSQL/TimescaleDB, manual Drizzle SQL migration, TypeScript CLI with `pnpm tsx`, Vitest integration tests, existing `executeWithSchema()` raw SQL pattern.

**Execution note:** ship this in two phases. Phase 1 creates and backfills the
projection without changing app read paths. Phase 2 migrates app queries only
after production row counts verify that `analytics.activity_training_summary` is
populated and `analytics.activity_rollup_dirty` is empty.

---

## Scope

This plan addresses app query pressure from repeated activity-level aggregation. It does not try to solve the full-history cost of rebuilding `fitness.deduped_sensor` or `fitness.activity_summary`; those remain separate materialized-view maintenance risks.

The first useful projection is `analytics.activity_training_summary`, one row per canonical activity. It stores derived read-model data that is cheap to rebuild from `fitness.v_activity`, `fitness.activity_summary`, and `fitness.deduped_sensor`.

The projection is explicitly not source data:

- `fitness.*` remains canonical.
- `analytics.*` can be dropped and rebuilt.
- app writes never treat `analytics.*` as source of truth.
- every row has `computed_at`.
- tests compare projection outputs to existing query behavior before router migration.

## Files

- Create: `drizzle/0001_activity_rollups.sql`
  - Creates `analytics` schema, `activity_training_summary`, `activity_rollup_dirty`, refresh functions, and dirty-marking triggers.
- Create: `src/db/run-activity-rollups.ts`
  - Small CLI to refresh dirty activity summaries or backfill all summaries.
- Create: `src/db/run-activity-rollups.test.ts`
  - Unit tests for CLI argument handling and required `DATABASE_URL`.
- Create: `src/db/activity-rollups.integration.test.ts`
  - Real DB tests for SQL functions and projection correctness.
- Modify: `packages/server/src/repositories/weekly-report-repository.ts`
  - Read activity training data from `analytics.activity_training_summary`.
- Modify: `packages/server/src/routers/recovery.ts`
  - Replace daily workload aggregation with the activity projection.
- Modify: `packages/server/src/routers/monthly-report.ts`
  - Replace monthly training aggregation with the activity projection.
- Modify: `packages/server/src/repositories/pmc-repository.ts`
  - Use projected normalized power instead of rescanning `deduped_sensor`.
- Modify: `packages/server/src/repositories/training-repository.ts`
  - Use projected HR histogram for weekly HR zones and next-workout zone totals.
- Modify: `docs/schema.md`
  - Document `fitness.*` versus `analytics.*` ownership.
- Modify: `docs/production-incident-baseline.md`
  - Add a follow-up note if implementation uncovers query or refresh behavior worth preserving.

## Projection Shape

Create this SQL-owned table:

```sql
CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE analytics.activity_training_summary (
  activity_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  activity_type text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_minutes double precision,
  avg_hr real,
  max_hr smallint,
  min_hr smallint,
  avg_power real,
  max_power smallint,
  avg_cadence real,
  avg_speed real,
  total_distance real,
  elevation_gain_m real,
  elevation_loss_m real,
  hr_sample_count integer NOT NULL DEFAULT 0,
  power_sample_count integer NOT NULL DEFAULT 0,
  total_sample_count integer NOT NULL DEFAULT 0,
  normalized_power real,
  hr_bpm_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  power_watt_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_training_summary_user_started_idx
  ON analytics.activity_training_summary (user_id, started_at DESC);

CREATE INDEX activity_training_summary_user_type_started_idx
  ON analytics.activity_training_summary (user_id, activity_type, started_at DESC);
```

Store histograms rather than precomputed HR zones. HR zones depend on user max HR and resting HR, which can change. Histograms let current app queries compute zone seconds from current settings without rescanning raw sensor rows.

## Task 1: Integration Test For Projection Refresh

**Files:**

- Create: `src/db/activity-rollups.integration.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `src/db/activity-rollups.integration.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setupTestDatabase } from "./test-helpers.ts";

describe("analytics activity rollups", () => {
  it("refreshes one activity summary from canonical views and deduped sensor data", async () => {
    const testContext = await setupTestDatabase();
    const userId = testContext.userId;

    await testContext.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('rollup-provider', 'Rollup Provider', ${userId})
      ON CONFLICT (id) DO NOTHING
    `);

    const activityRows = await testContext.db.execute<{ id: string }>(sql`
      INSERT INTO fitness.activity (
        provider_id, user_id, activity_type, started_at, ended_at, name
      )
      VALUES (
        'rollup-provider',
        ${userId},
        'cycling',
        '2026-04-20T10:00:00Z',
        '2026-04-20T10:05:00Z',
        'Rollup Ride'
      )
      RETURNING id
    `);
    const activityId = activityRows[0]?.id;
    expect(activityId).toBeDefined();

    await testContext.db.execute(sql`
      INSERT INTO fitness.metric_stream (
        recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar
      )
      VALUES
        ('2026-04-20T10:00:00Z', ${userId}, 'rollup-provider', 'dev-1', 'api', 'heart_rate', ${activityId}::uuid, 120),
        ('2026-04-20T10:01:00Z', ${userId}, 'rollup-provider', 'dev-1', 'api', 'heart_rate', ${activityId}::uuid, 130),
        ('2026-04-20T10:02:00Z', ${userId}, 'rollup-provider', 'dev-1', 'api', 'heart_rate', ${activityId}::uuid, 140),
        ('2026-04-20T10:00:00Z', ${userId}, 'rollup-provider', 'dev-1', 'api', 'power', ${activityId}::uuid, 180),
        ('2026-04-20T10:01:00Z', ${userId}, 'rollup-provider', 'dev-1', 'api', 'power', ${activityId}::uuid, 200),
        ('2026-04-20T10:02:00Z', ${userId}, 'rollup-provider', 'dev-1', 'api', 'power', ${activityId}::uuid, 220)
    `);

    await testContext.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);
    await testContext.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.deduped_sensor`);
    await testContext.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.activity_summary`);

    await testContext.db.execute(
      sql`SELECT analytics.refresh_activity_training_summary(${activityId}::uuid)`,
    );

    const rows = await testContext.db.execute<{
      avg_hr: number;
      avg_power: number;
      hr_sample_count: number;
      power_sample_count: number;
      hr_bpm_counts: Record<string, number>;
      power_watt_counts: Record<string, number>;
    }>(sql`
      SELECT avg_hr, avg_power, hr_sample_count, power_sample_count,
             hr_bpm_counts, power_watt_counts
      FROM analytics.activity_training_summary
      WHERE activity_id = ${activityId}::uuid
    `);

    expect(rows[0]).toMatchObject({
      avg_hr: 130,
      avg_power: 200,
      hr_sample_count: 3,
      power_sample_count: 3,
    });
    expect(rows[0]?.hr_bpm_counts).toEqual({ "120": 1, "130": 1, "140": 1 });
    expect(rows[0]?.power_watt_counts).toEqual({ "180": 1, "200": 1, "220": 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
docker compose up -d db redis
docker compose ps db redis
pnpm vitest run src/db/activity-rollups.integration.test.ts
```

Expected: FAIL with `schema "analytics" does not exist` or `function analytics.refresh_activity_training_summary(uuid) does not exist`.

## Task 2: SQL Migration For Analytics Schema

**Files:**

- Create: `drizzle/0001_activity_rollups.sql`

- [ ] **Step 1: Find next migration number**

Run:

```bash
ls drizzle/*.sql | sort | tail -n 5
```

Create `drizzle/0001_activity_rollups.sql`; the current migration set only has `0000_baseline.sql`.

- [ ] **Step 2: Add schema, tables, and refresh function**

Add this migration body to the new file:

```sql
CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE analytics.activity_training_summary (
  activity_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  activity_type text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_minutes double precision,
  avg_hr real,
  max_hr smallint,
  min_hr smallint,
  avg_power real,
  max_power smallint,
  avg_cadence real,
  avg_speed real,
  total_distance real,
  elevation_gain_m real,
  elevation_loss_m real,
  hr_sample_count integer NOT NULL DEFAULT 0,
  power_sample_count integer NOT NULL DEFAULT 0,
  total_sample_count integer NOT NULL DEFAULT 0,
  normalized_power real,
  hr_bpm_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  power_watt_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_training_summary_user_started_idx
  ON analytics.activity_training_summary (user_id, started_at DESC);

CREATE INDEX activity_training_summary_user_type_started_idx
  ON analytics.activity_training_summary (user_id, activity_type, started_at DESC);

CREATE TABLE analytics.activity_rollup_dirty (
  activity_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  reason text NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_rollup_dirty_marked_idx
  ON analytics.activity_rollup_dirty (marked_at ASC);
```

Then add the refresh function:

```sql
CREATE OR REPLACE FUNCTION analytics.refresh_activity_training_summary(target_activity_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO analytics.activity_training_summary (
    activity_id,
    user_id,
    activity_type,
    started_at,
    ended_at,
    duration_minutes,
    avg_hr,
    max_hr,
    min_hr,
    avg_power,
    max_power,
    avg_cadence,
    avg_speed,
    total_distance,
    elevation_gain_m,
    elevation_loss_m,
    hr_sample_count,
    power_sample_count,
    total_sample_count,
    normalized_power,
    hr_bpm_counts,
    power_watt_counts,
    computed_at
  )
  WITH activity_row AS (
    SELECT
      va.id AS activity_id,
      va.user_id,
      va.activity_type,
      va.started_at,
      va.ended_at,
      asum.avg_hr,
      asum.max_hr,
      asum.min_hr,
      asum.avg_power,
      asum.max_power,
      asum.avg_cadence,
      asum.avg_speed,
      asum.total_distance,
      asum.elevation_gain_m,
      asum.elevation_loss_m,
      asum.hr_sample_count,
      asum.power_sample_count,
      asum.sample_count AS total_sample_count
    FROM fitness.v_activity va
    LEFT JOIN fitness.activity_summary asum ON asum.activity_id = va.id
    WHERE va.id = target_activity_id
  ),
  power_rolling AS (
    SELECT
      ds.activity_id,
      AVG(ds.scalar) OVER (
        PARTITION BY ds.activity_id
        ORDER BY ds.recorded_at
        RANGE BETWEEN INTERVAL '29 seconds' PRECEDING AND CURRENT ROW
      ) AS rolling_30s_power
    FROM fitness.deduped_sensor ds
    WHERE ds.activity_id = target_activity_id
      AND ds.channel = 'power'
      AND ds.scalar > 0
  ),
  normalized_power AS (
    SELECT
      activity_id,
      CASE
        WHEN COUNT(*) >= 60
        THEN ROUND(POWER(AVG(POWER(rolling_30s_power, 4)), 0.25)::numeric, 1)::real
        ELSE NULL::real
      END AS normalized_power
    FROM power_rolling
    GROUP BY activity_id
  ),
  hr_histogram AS (
    SELECT
      activity_id,
      COALESCE(jsonb_object_agg(bpm::text, sample_count ORDER BY bpm), '{}'::jsonb) AS hr_bpm_counts
    FROM (
      SELECT
        activity_id,
        ROUND(scalar)::int AS bpm,
        COUNT(*)::int AS sample_count
      FROM fitness.deduped_sensor
      WHERE activity_id = target_activity_id
        AND channel = 'heart_rate'
        AND scalar IS NOT NULL
        AND scalar > 0
      GROUP BY activity_id, ROUND(scalar)::int
    ) counts
    GROUP BY activity_id
  ),
  power_histogram AS (
    SELECT
      activity_id,
      COALESCE(jsonb_object_agg(watts::text, sample_count ORDER BY watts), '{}'::jsonb) AS power_watt_counts
    FROM (
      SELECT
        activity_id,
        ROUND(scalar)::int AS watts,
        COUNT(*)::int AS sample_count
      FROM fitness.deduped_sensor
      WHERE activity_id = target_activity_id
        AND channel = 'power'
        AND scalar IS NOT NULL
        AND scalar > 0
      GROUP BY activity_id, ROUND(scalar)::int
    ) counts
    GROUP BY activity_id
  )
  SELECT
    ar.activity_id,
    ar.user_id,
    ar.activity_type,
    ar.started_at,
    ar.ended_at,
    EXTRACT(EPOCH FROM (ar.ended_at - ar.started_at)) / 60.0 AS duration_minutes,
    ar.avg_hr,
    ar.max_hr,
    ar.min_hr,
    ar.avg_power,
    ar.max_power,
    ar.avg_cadence,
    ar.avg_speed,
    ar.total_distance,
    ar.elevation_gain_m,
    ar.elevation_loss_m,
    COALESCE(ar.hr_sample_count, 0),
    COALESCE(ar.power_sample_count, 0),
    COALESCE(ar.total_sample_count, 0),
    np.normalized_power,
    COALESCE(hr.hr_bpm_counts, '{}'::jsonb),
    COALESCE(pwr.power_watt_counts, '{}'::jsonb),
    now()
  FROM activity_row ar
  LEFT JOIN normalized_power np ON np.activity_id = ar.activity_id
  LEFT JOIN hr_histogram hr ON hr.activity_id = ar.activity_id
  LEFT JOIN power_histogram pwr ON pwr.activity_id = ar.activity_id
  ON CONFLICT (activity_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    activity_type = EXCLUDED.activity_type,
    started_at = EXCLUDED.started_at,
    ended_at = EXCLUDED.ended_at,
    duration_minutes = EXCLUDED.duration_minutes,
    avg_hr = EXCLUDED.avg_hr,
    max_hr = EXCLUDED.max_hr,
    min_hr = EXCLUDED.min_hr,
    avg_power = EXCLUDED.avg_power,
    max_power = EXCLUDED.max_power,
    avg_cadence = EXCLUDED.avg_cadence,
    avg_speed = EXCLUDED.avg_speed,
    total_distance = EXCLUDED.total_distance,
    elevation_gain_m = EXCLUDED.elevation_gain_m,
    elevation_loss_m = EXCLUDED.elevation_loss_m,
    hr_sample_count = EXCLUDED.hr_sample_count,
    power_sample_count = EXCLUDED.power_sample_count,
    total_sample_count = EXCLUDED.total_sample_count,
    normalized_power = EXCLUDED.normalized_power,
    hr_bpm_counts = EXCLUDED.hr_bpm_counts,
    power_watt_counts = EXCLUDED.power_watt_counts,
    computed_at = EXCLUDED.computed_at;
END;
$$;
```

- [ ] **Step 3: Add dirty drain function**

Append:

```sql
CREATE OR REPLACE FUNCTION analytics.refresh_dirty_activity_training_summaries(batch_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  refreshed_count integer := 0;
  dirty_record record;
BEGIN
  FOR dirty_record IN
    SELECT activity_id
    FROM analytics.activity_rollup_dirty
    ORDER BY marked_at ASC
    LIMIT batch_limit
  LOOP
    PERFORM analytics.refresh_activity_training_summary(dirty_record.activity_id);
    DELETE FROM analytics.activity_rollup_dirty
    WHERE activity_id = dirty_record.activity_id;
    refreshed_count := refreshed_count + 1;
  END LOOP;

  RETURN refreshed_count;
END;
$$;
```

- [ ] **Step 4: Run migration locally**

Run:

```bash
pnpm migrate
```

Expected: migration applies without interactive prompts.

- [ ] **Step 5: Run failing test again**

Run:

```bash
pnpm vitest run src/db/activity-rollups.integration.test.ts
```

Expected: PASS for the single-activity projection test.

- [ ] **Step 6: Commit**

```bash
git add drizzle/0001_activity_rollups.sql src/db/activity-rollups.integration.test.ts
git commit -m "feat: add sql-owned activity rollup projection"
git push
```

## Task 3: Dirty Marking Inside Postgres

**Files:**

- Modify: `drizzle/0001_activity_rollups.sql`
- Test: `src/db/activity-rollups.integration.test.ts`

- [ ] **Step 1: Add failing test for metric stream dirty marking**

Append this test:

```ts
it("marks linked activities dirty when metric stream rows are inserted", async () => {
  const testContext = await setupTestDatabase();
  const userId = testContext.userId;

  await testContext.db.execute(sql`
    INSERT INTO fitness.provider (id, name, user_id)
    VALUES ('dirty-provider', 'Dirty Provider', ${userId})
    ON CONFLICT (id) DO NOTHING
  `);

  const activityRows = await testContext.db.execute<{ id: string }>(sql`
    INSERT INTO fitness.activity (
      provider_id, user_id, activity_type, started_at, ended_at, name
    )
    VALUES (
      'dirty-provider',
      ${userId},
      'cycling',
      '2026-04-21T10:00:00Z',
      '2026-04-21T11:00:00Z',
      'Dirty Ride'
    )
    RETURNING id
  `);
  const activityId = activityRows[0]?.id;
  expect(activityId).toBeDefined();

  await testContext.db.execute(sql`
    INSERT INTO fitness.metric_stream (
      recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar
    )
    VALUES (
      '2026-04-21T10:00:00Z',
      ${userId},
      'dirty-provider',
      'dev-1',
      'api',
      'heart_rate',
      ${activityId}::uuid,
      123
    )
  `);

  const rows = await testContext.db.execute<{ activity_id: string; reason: string }>(sql`
    SELECT activity_id::text, reason
    FROM analytics.activity_rollup_dirty
    WHERE activity_id = ${activityId}::uuid
  `);

  expect(rows).toEqual([{ activity_id: activityId, reason: "metric_stream_changed" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run src/db/activity-rollups.integration.test.ts -t "marks linked activities dirty"
```

Expected: FAIL because no trigger inserts into `analytics.activity_rollup_dirty`.

- [ ] **Step 3: Add statement-level triggers**

Append to the migration:

```sql
CREATE OR REPLACE FUNCTION analytics.mark_activity_rollup_dirty_from_metric_stream_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO analytics.activity_rollup_dirty (activity_id, user_id, reason, marked_at)
  SELECT DISTINCT activity_id, user_id, 'metric_stream_changed', now()
  FROM new_rows
  WHERE activity_id IS NOT NULL
  ON CONFLICT (activity_id) DO UPDATE SET
    reason = EXCLUDED.reason,
    marked_at = EXCLUDED.marked_at;

  RETURN NULL;
END;
$$;

CREATE TRIGGER metric_stream_activity_rollup_dirty_insert
AFTER INSERT ON fitness.metric_stream
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION analytics.mark_activity_rollup_dirty_from_metric_stream_insert();

CREATE OR REPLACE FUNCTION analytics.mark_activity_rollup_dirty_from_metric_stream_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO analytics.activity_rollup_dirty (activity_id, user_id, reason, marked_at)
  SELECT DISTINCT activity_id, user_id, 'metric_stream_changed', now()
  FROM old_rows
  WHERE activity_id IS NOT NULL
  ON CONFLICT (activity_id) DO UPDATE SET
    reason = EXCLUDED.reason,
    marked_at = EXCLUDED.marked_at;

  RETURN NULL;
END;
$$;

CREATE TRIGGER metric_stream_activity_rollup_dirty_delete
AFTER DELETE ON fitness.metric_stream
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION analytics.mark_activity_rollup_dirty_from_metric_stream_delete();
```

Do not add row-level triggers on `metric_stream`; statement-level transition-table triggers are required to avoid per-sample overhead.

- [ ] **Step 4: Add activity table dirty trigger**

Append:

```sql
CREATE OR REPLACE FUNCTION analytics.mark_activity_rollup_dirty_from_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO analytics.activity_rollup_dirty (activity_id, user_id, reason, marked_at)
  SELECT DISTINCT id, user_id, 'activity_changed', now()
  FROM (
    SELECT id, user_id FROM new_rows
    UNION
    SELECT id, user_id FROM old_rows
  ) changed
  ON CONFLICT (activity_id) DO UPDATE SET
    reason = EXCLUDED.reason,
    marked_at = EXCLUDED.marked_at;

  RETURN NULL;
END;
$$;

CREATE TRIGGER activity_rollup_dirty_update
AFTER UPDATE ON fitness.activity
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION analytics.mark_activity_rollup_dirty_from_activity();
```

Use `UPDATE` only here. Inserts are covered once metric rows arrive, and deletes cascade/delete raw data where the projection can be rebuilt by backfill if needed.

- [ ] **Step 5: Run test**

Run:

```bash
pnpm vitest run src/db/activity-rollups.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add drizzle/0001_activity_rollups.sql src/db/activity-rollups.integration.test.ts
git commit -m "feat: mark activity rollups dirty from database changes"
git push
```

## Task 4: TypeScript Drain CLI

**Files:**

- Create: `src/db/run-activity-rollups.ts`
- Create: `src/db/run-activity-rollups.test.ts`

- [ ] **Step 1: Write CLI tests**

Create `src/db/run-activity-rollups.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockClientConnect, mockClientEnd, mockClientQuery, mockClientConstructor } = vi.hoisted(
  () => {
    const clientInstance = {
      connect: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [{ refreshed_count: 3 }] }),
    };
    return {
      mockClientConnect: clientInstance.connect,
      mockClientEnd: clientInstance.end,
      mockClientQuery: clientInstance.query,
      mockClientConstructor: vi.fn(() => clientInstance),
    };
  },
);

vi.mock("pg", async (importOriginal) => {
  const original = await importOriginal<typeof import("pg")>();
  return { ...original, Client: mockClientConstructor };
});

import { main } from "./run-activity-rollups.ts";

describe("run-activity-rollups main()", () => {
  const originalArguments = process.argv;
  const originalUrl = process.env.DATABASE_URL;
  const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  beforeEach(() => {
    process.argv = ["node", "run-activity-rollups.ts", "drain"];
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockClientConnect.mockClear();
    mockClientEnd.mockClear();
    mockClientQuery.mockClear();
    mockClientConstructor.mockClear();
    stdoutWriteSpy.mockClear();
  });

  afterEach(() => {
    process.argv = originalArguments;
    if (originalUrl) process.env.DATABASE_URL = originalUrl;
    else delete process.env.DATABASE_URL;
  });

  it("requires DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    await expect(main()).rejects.toThrow("DATABASE_URL");
  });

  it("drains dirty rollups with default batch size", async () => {
    await main();
    expect(mockClientQuery).toHaveBeenCalledWith(
      "SELECT analytics.refresh_dirty_activity_training_summaries($1) AS refreshed_count",
      [100],
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith("refreshed=3\n");
    expect(mockClientEnd).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run src/db/run-activity-rollups.test.ts
```

Expected: FAIL because `src/db/run-activity-rollups.ts` does not exist.

- [ ] **Step 3: Implement CLI**

Create `src/db/run-activity-rollups.ts`:

```ts
import { Client } from "pg";

function databaseUrlFromEnv(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return databaseUrl;
}

function batchSizeFromArguments(): number {
  const batchSizeArgument = process.argv[3];
  if (!batchSizeArgument) {
    return 100;
  }
  const batchSize = Number.parseInt(batchSizeArgument, 10);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("Batch size must be an integer between 1 and 1000");
  }
  return batchSize;
}

export async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "drain") {
    throw new Error("Usage: pnpm tsx src/db/run-activity-rollups.ts drain [batchSize]");
  }

  const client = new Client({ connectionString: databaseUrlFromEnv() });
  try {
    await client.connect();
    const result = await client.query<{ refreshed_count: number }>(
      "SELECT analytics.refresh_dirty_activity_training_summaries($1) AS refreshed_count",
      [batchSizeFromArguments()],
    );
    process.stdout.write(`refreshed=${result.rows[0]?.refreshed_count ?? 0}\n`);
  } finally {
    await client.end();
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm vitest run src/db/run-activity-rollups.test.ts
pnpm tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/run-activity-rollups.ts src/db/run-activity-rollups.test.ts
git commit -m "feat: add activity rollup drain command"
git push
```

## Task 5: Migrate Daily Load Readers

**Files:**

- Modify: `packages/server/src/repositories/weekly-report-repository.ts`
- Modify: `packages/server/src/routers/recovery.ts`
- Modify: `packages/server/src/routers/monthly-report.ts`
- Modify tests near changed routers.

- [ ] **Step 1: Update weekly report query**

In `packages/server/src/repositories/weekly-report-repository.ts`, replace the `per_activity` CTE source with `analytics.activity_training_summary`:

```sql
per_activity AS (
  SELECT
    (summary.started_at AT TIME ZONE ${this.#timezone})::date AS date,
    summary.duration_minutes / 60.0 AS hours,
    summary.duration_minutes
      * summary.avg_hr
      / NULLIF(summary.max_hr, 0) AS load
  FROM analytics.activity_training_summary summary
  WHERE summary.user_id = ${this.#userId}
    AND (summary.started_at AT TIME ZONE ${this.#timezone})::date >= ${dateWindowStart(endDate, totalDays)}
    AND summary.ended_at IS NOT NULL
    AND summary.avg_hr IS NOT NULL
)
```

Keep the rest of the query unchanged.

- [ ] **Step 2: Update recovery workload ratio query**

In `packages/server/src/routers/recovery.ts`, replace its `per_activity` CTE with the same `analytics.activity_training_summary` shape:

```sql
per_activity AS (
  SELECT
    (summary.started_at AT TIME ZONE ${ctx.timezone})::date AS date,
    summary.duration_minutes
      * summary.avg_hr
      / NULLIF(summary.max_hr, 0) AS load
  FROM analytics.activity_training_summary summary
  WHERE summary.user_id = ${ctx.userId}
    AND (summary.started_at AT TIME ZONE ${ctx.timezone})::date >= ${dateWindowStart(input.endDate, queryDays)}
    AND summary.ended_at IS NOT NULL
    AND summary.avg_hr IS NOT NULL
)
```

- [ ] **Step 3: Update monthly report query**

In `packages/server/src/routers/monthly-report.ts`, replace `per_activity`:

```sql
per_activity AS (
  SELECT
    summary.started_at::date AS date,
    summary.duration_minutes / 60.0 AS hours,
    summary.duration_minutes
      * summary.avg_hr
      / NULLIF(summary.max_hr, 0) AS load
  FROM analytics.activity_training_summary summary
  WHERE summary.user_id = ${ctx.userId}
    AND summary.started_at >= date_trunc('month', CURRENT_DATE) - (${input.months}::int || ' months')::interval
    AND summary.ended_at IS NOT NULL
    AND summary.avg_hr IS NOT NULL
)
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/server/src/routers/recovery.test.ts packages/server/src/routers/weekly-report.test.ts packages/server/src/routers/monthly-report.test.ts
```

Expected: update test mocks/fixtures to include `analytics.activity_training_summary` rows where integration tests previously inserted only `activity_summary` rows. Unit tests that assert SQL strings should expect `analytics.activity_training_summary`.

- [ ] **Step 5: Run changed tests**

Run:

```bash
pnpm test:changed
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/repositories/weekly-report-repository.ts packages/server/src/routers/recovery.ts packages/server/src/routers/monthly-report.ts packages/server/src/**/*.test.ts
git commit -m "feat: read daily training load from activity rollups"
git push
```

## Task 6: Migrate PMC Normalized Power Reader

**Files:**

- Modify: `packages/server/src/repositories/pmc-repository.ts`
- Modify tests covering PMC.

- [ ] **Step 1: Replace normalized power raw scan**

In `packages/server/src/repositories/pmc-repository.ts`, replace Query 2 with:

```ts
const npRows = await this.query(
  normalizedPowerRowSchema,
  sql`SELECT
        activity_id,
        normalized_power AS np
      FROM analytics.activity_training_summary
      WHERE user_id = ${this.userId}
        AND started_at > NOW() - ${queryDays}::int * INTERVAL '1 day'
        AND normalized_power IS NOT NULL`,
);
```

- [ ] **Step 2: Keep Query 1 on summary table initially**

Do not change Query 1 in the same task. Query 1 already reads `activity_summary`, not raw `deduped_sensor`; migrating it can be combined with daily-load readers later if tests show value.

- [ ] **Step 3: Run PMC tests**

Run:

```bash
pnpm vitest run packages/server/src/routers/pmc.test.ts packages/server/src/routers/nutrition-analytics-pmc-power.test.ts
```

Expected: PASS after updating SQL-string expectations or fixtures for `analytics.activity_training_summary`.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/repositories/pmc-repository.ts packages/server/src/routers/*pmc*.test.ts
git commit -m "feat: use activity rollups for pmc normalized power"
git push
```

## Task 7: Migrate HR Zone Aggregations To Histograms

**Files:**

- Modify: `packages/server/src/repositories/training-repository.ts`
- Modify tests covering `training.hrZones` and `training.nextWorkout`.

- [ ] **Step 1: Replace weekly HR zone query source**

In `getHrZones()`, replace the `deduped_sensor` join with `jsonb_each_text(summary.hr_bpm_counts)`.

Use this SQL shape:

```sql
SELECT
  up.max_hr,
  date_trunc('week', (summary.started_at AT TIME ZONE ${this.timezone})::date)::date AS week,
  SUM(CASE
    WHEN bpm.value::int >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.5
     AND bpm.value::int <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.6
    THEN bpm.count::int ELSE 0 END)::int AS zone1,
  SUM(CASE
    WHEN bpm.value::int >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.6
     AND bpm.value::int <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.7
    THEN bpm.count::int ELSE 0 END)::int AS zone2,
  SUM(CASE
    WHEN bpm.value::int >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.7
     AND bpm.value::int <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8
    THEN bpm.count::int ELSE 0 END)::int AS zone3,
  SUM(CASE
    WHEN bpm.value::int >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8
     AND bpm.value::int <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.9
    THEN bpm.count::int ELSE 0 END)::int AS zone4,
  SUM(CASE
    WHEN bpm.value::int >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.9
    THEN bpm.count::int ELSE 0 END)::int AS zone5
FROM fitness.user_profile up
JOIN analytics.activity_training_summary summary ON summary.user_id = up.id
JOIN LATERAL jsonb_each_text(summary.hr_bpm_counts) AS bpm(value, count) ON true
JOIN ${restingHeartRateLateral(sql`up.id`, sql`(summary.started_at AT TIME ZONE ${this.timezone})::date`)}
WHERE up.id = ${this.userId}
  AND summary.started_at > NOW() - ${days}::int * INTERVAL '1 day'
  AND ${enduranceTypeFilter("summary")}
  AND up.max_hr IS NOT NULL
GROUP BY up.max_hr, 2
ORDER BY week
```

- [ ] **Step 2: Replace nextWorkout zone totals**

In `#fetchZoneTotals()`, use the same histogram pattern over the last 14 days.

- [ ] **Step 3: Run training tests**

Run:

```bash
pnpm vitest run packages/server/src/routers/efficiency-training-intervals.test.ts packages/server/src/routers/recovery-settings-sleep-need-sport-settings.test.ts
```

Expected: PASS after fixture updates.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/repositories/training-repository.ts packages/server/src/routers/*training*.test.ts packages/server/src/routers/recovery-settings-sleep-need-sport-settings.test.ts
git commit -m "feat: use activity rollup histograms for hr zones"
git push
```

## Task 8: Backfill And Operational Runbook

**Files:**

- Modify: `docs/schema.md`
- Create: `docs/activity-rollups-runbook.md`
- Modify: `docs/README.md`

- [ ] **Step 1: Add backfill SQL command to runbook**

Create `docs/activity-rollups-runbook.md`:

```markdown
# Activity Rollups Runbook

`fitness.*` is the raw source of truth. `analytics.*` contains rebuildable read models.

## Backfill

Run after deploying the migration:

```sql
INSERT INTO analytics.activity_rollup_dirty (activity_id, user_id, reason, marked_at)
SELECT id, user_id, 'backfill', now()
FROM fitness.v_activity
ON CONFLICT (activity_id) DO UPDATE SET
  reason = EXCLUDED.reason,
  marked_at = EXCLUDED.marked_at;
```

Then drain in batches:

```bash
pnpm tsx src/db/run-activity-rollups.ts drain 100
```

Repeat until the command prints `refreshed=0`.

## Rebuild

The projection can be rebuilt from scratch:

```sql
TRUNCATE analytics.activity_training_summary;
INSERT INTO analytics.activity_rollup_dirty (activity_id, user_id, reason, marked_at)
SELECT id, user_id, 'full_rebuild', now()
FROM fitness.v_activity
ON CONFLICT (activity_id) DO UPDATE SET
  reason = EXCLUDED.reason,
  marked_at = EXCLUDED.marked_at;
```

Drain with:

```bash
pnpm tsx src/db/run-activity-rollups.ts drain 100
```

## Known Boundaries

- Activity stream charts still read `fitness.deduped_sensor`.
- Duration curves still read ordered sensor samples.
- This projection reduces repeated app query work; it does not remove the need for safe materialized-view maintenance.
```

- [ ] **Step 2: Update schema doc**

In `docs/schema.md`, add:

```markdown
### Derived Read Models

`analytics.*` contains rebuildable derived tables. These tables are not source of truth and may be dropped/rebuilt from `fitness.*`.

Current projections:

| Table | Purpose |
|-------|---------|
| `analytics.activity_training_summary` | Per-activity training summary and histograms used by app analytics. |
| `analytics.activity_rollup_dirty` | Work queue for activity projection refresh. |
```

- [ ] **Step 3: Link runbook**

Add `docs/activity-rollups-runbook.md` to `docs/README.md` under Operations And Runbooks.

- [ ] **Step 4: Commit**

```bash
git add docs/schema.md docs/activity-rollups-runbook.md docs/README.md
git commit -m "docs: document activity rollup read models"
git push
```

## Task 9: Final Verification

**Files:**

- All changed files.

- [ ] **Step 1: Run required checks**

Run:

```bash
pnpm lint
pnpm test:changed
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd ../web && pnpm tsc --noEmit
```

Expected: all pass.

- [ ] **Step 2: Run migration smoke test**

Run:

```bash
pnpm migrate
pnpm vitest run src/db/activity-rollups.integration.test.ts
```

Expected: migration is idempotent on the local DB and integration tests pass.

- [ ] **Step 3: Check production incident baseline**

If implementation uncovers a production or operational issue, append a concise entry to `docs/production-incident-baseline.md` with date, symptoms, evidence, root cause, fix, remaining risk, and follow-up work.

- [ ] **Step 4: Commit final fixes**

```bash
git status --short
git add .
git commit -m "chore: verify activity rollup rollout"
git push
```

Only run this commit if verification required follow-up edits. Do not create an empty commit.

## Rollout Notes

Deploy order:

1. Ship migration and CLI.
2. Backfill `analytics.activity_training_summary`.
3. Verify row counts:

   ```sql
   SELECT count(*) FROM fitness.v_activity;
   SELECT count(*) FROM analytics.activity_training_summary;
   SELECT count(*) FROM analytics.activity_rollup_dirty;
   ```

4. Ship router migrations.
5. Watch slow SQL and DB CPU/memory during first production traffic window.

Rollback:

- App router changes can be reverted to read existing `activity_summary` / `deduped_sensor`.
- `analytics.*` tables can remain in place during rollback because they are read-only projections.
- Do not drop `analytics.*` in an emergency rollback; leaving unused projections is safer than a second migration during an incident.

## Plan Self-Review

- Spec coverage: covers SQL-owned derived schema, no app-owned math, initial app query migrations, docs, tests, and rollout.
- Placeholder scan: no unresolved placeholders are present. The migration path is `drizzle/0001_activity_rollups.sql` because the current migration set only has `0000_baseline.sql`.
- Scope check: this is one bounded subsystem. It intentionally excludes replacing activity stream charts, duration curves, interval detection, and materialized-view refresh mechanics.
