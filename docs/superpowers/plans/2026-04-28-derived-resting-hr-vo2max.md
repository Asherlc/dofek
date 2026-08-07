# Derived Resting Heart Rate and VO2 Max Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove stored provider `resting_hr` and `vo2max` daily metric columns, then replace consumers with transparent server-derived resting heart rate and VO2 Max calculations.

**Architecture:** Keep raw facts in existing tables, remove the two derived/provider-estimated columns from `fitness.daily_metrics`, and add a focused derived-cardio calculation path. Pure formulas live in `@dofek/training`; database retrieval and aggregation live in a new server repository; healthspan and UI consumers call that repository instead of reading removed daily metric fields.

**Tech Stack:** TypeScript, Drizzle ORM, Zod `executeWithSchema()`, PostgreSQL/TimescaleDB, Vitest, pnpm.

---

## File Structure

- Create `packages/training/src/derived-cardio.ts`
  - Pure, dependency-light formula helpers for VO2 Max estimates and averaging.
- Create `packages/training/src/derived-cardio.test.ts`
  - Unit tests for cycling power formula, ACSM segment formula, quality filters, and averaging.
- Modify `packages/training/package.json`
  - Export `./derived-cardio`.
- Create `packages/server/src/repositories/derived-cardio-repository.ts`
  - DB-backed derived resting HR and VO2 Max calculations.
- Create `packages/server/src/repositories/derived-cardio-repository.test.ts`
  - Unit tests with mocked `execute()` results for repository mapping and aggregation behavior.
- Create `packages/server/src/repositories/derived-cardio-repository.integration.test.ts`
  - Real DB tests for sleep-window resting HR and activity-derived VO2 Max inputs.
- Modify `src/db/schema.ts`
  - Remove `dailyMetrics.restingHr` and `dailyMetrics.vo2max`.
- Create a manual migration under `drizzle/0007_remove_resting_hr_vo2max.sql`
  - Drop `fitness.v_daily_metrics`, drop columns, and allow the view runner to recreate canonical views.
- Modify `drizzle/_views/04_v_daily_metrics.sql`
  - Remove `resting_hr` and `vo2max` output columns.
- Modify provider persistence files:
  - `src/providers/apple-health/db-insertion.ts`
  - `packages/server/src/routers/health-kit-sync-schemas.ts`
  - `packages/server/src/routers/health-kit-sync-processors.ts`
  - `packages/server/src/repositories/health-kit-sync-repository.ts`
  - `src/providers/garmin.ts`
  - `src/providers/oura/parsing.ts`
  - `src/providers/oura/sync-steps.ts`
  - `src/providers/ultrahuman.ts`
  - `src/providers/zwift.ts`
- Modify daily metrics API files:
  - `packages/server/src/repositories/daily-metrics-repository.ts`
  - `packages/server/src/routers/daily-metrics.ts`
  - web/mobile schemas that currently expect `resting_hr` or `vo2max`.
- Modify healthspan files:
  - `packages/server/src/routers/healthspan-query.ts`
  - `packages/server/src/routers/healthspan.ts`
  - `packages/server/src/routers/healthspan.test.ts`
  - `packages/server/src/routers/healthspan.integration.test.ts`
- Modify cycling UI:
  - `packages/web/src/routes/training/cycling.tsx`
  - Reuse server-derived VO2 Max query instead of local formula.
- Update docs:
  - `docs/schema.md`
  - `docs/schema.dbml` and `docs/schema.puml` if generated schema docs are tracked manually in this repo.

---

### Task 1: Pure Derived Cardio Formulas

**Files:**
- Create: `packages/training/src/derived-cardio.ts`
- Create: `packages/training/src/derived-cardio.test.ts`
- Modify: `packages/training/package.json`

- [ ] **Step 1: Write failing tests for transparent formulas**

Create `packages/training/src/derived-cardio.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  averageVo2MaxEstimates,
  estimateCyclingVo2Max,
  estimateSubmaximalAcsmVo2Max,
  isSupportedOutdoorVo2MaxActivityType,
} from "./derived-cardio.ts";

describe("estimateCyclingVo2Max", () => {
  it("uses five-minute power divided by body weight", () => {
    expect(estimateCyclingVo2Max({ fiveMinutePowerWatts: 300, weightKg: 75 })).toBeCloseTo(
      50.2,
      1,
    );
  });

  it("returns null for implausible power or missing weight", () => {
    expect(estimateCyclingVo2Max({ fiveMinutePowerWatts: 49, weightKg: 75 })).toBeNull();
    expect(estimateCyclingVo2Max({ fiveMinutePowerWatts: 701, weightKg: 75 })).toBeNull();
    expect(estimateCyclingVo2Max({ fiveMinutePowerWatts: 300, weightKg: null })).toBeNull();
  });
});

describe("estimateSubmaximalAcsmVo2Max", () => {
  it("uses walking ACSM equation below 134 meters per minute", () => {
    const result = estimateSubmaximalAcsmVo2Max({
      speedMetersPerMinute: 100,
      gradeFraction: 0,
      averageHeartRate: 140,
      restingHeartRate: 60,
      maxHeartRate: 190,
    });

    expect(result).toBeCloseTo(21.94, 2);
  });

  it("uses running ACSM equation at or above 134 meters per minute", () => {
    const result = estimateSubmaximalAcsmVo2Max({
      speedMetersPerMinute: 200,
      gradeFraction: 0,
      averageHeartRate: 160,
      restingHeartRate: 60,
      maxHeartRate: 190,
    });

    expect(result).toBeCloseTo(56.55, 2);
  });

  it("rejects segments outside quality limits", () => {
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 39,
        gradeFraction: 0,
        averageHeartRate: 160,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeNull();
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 200,
        gradeFraction: 0.16,
        averageHeartRate: 160,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeNull();
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 200,
        gradeFraction: 0,
        averageHeartRate: 120,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeNull();
  });
});

describe("averageVo2MaxEstimates", () => {
  it("averages every qualifying activity estimate", () => {
    expect(averageVo2MaxEstimates([40, null, 50, 55])).toBeCloseTo(48.33, 2);
  });

  it("returns null when no estimates qualify", () => {
    expect(averageVo2MaxEstimates([null, null])).toBeNull();
  });
});

describe("isSupportedOutdoorVo2MaxActivityType", () => {
  it("includes outdoor locomotion activity types only", () => {
    expect(isSupportedOutdoorVo2MaxActivityType("running")).toBe(true);
    expect(isSupportedOutdoorVo2MaxActivityType("trail_running")).toBe(true);
    expect(isSupportedOutdoorVo2MaxActivityType("walking")).toBe(true);
    expect(isSupportedOutdoorVo2MaxActivityType("hiking")).toBe(true);
    expect(isSupportedOutdoorVo2MaxActivityType("indoor_running")).toBe(false);
    expect(isSupportedOutdoorVo2MaxActivityType("strength")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the formula tests to verify RED**

Run:

```bash
pnpm vitest packages/training/src/derived-cardio.test.ts
```

Expected: FAIL with an import/module-not-found error for `./derived-cardio.ts`.

- [ ] **Step 3: Implement formula helpers**

Create `packages/training/src/derived-cardio.ts`:

```ts
const MIN_CYCLING_POWER_WATTS = 50;
const MAX_CYCLING_POWER_WATTS = 700;
const MIN_SPEED_METERS_PER_MINUTE = 40;
const MAX_SPEED_METERS_PER_MINUTE = 450;
const MIN_GRADE_FRACTION = -0.15;
const MAX_GRADE_FRACTION = 0.15;
const RUNNING_THRESHOLD_METERS_PER_MINUTE = 134;
const MIN_HEART_RATE_RESERVE_FRACTION = 0.6;

export interface CyclingVo2MaxInput {
  fiveMinutePowerWatts: number;
  weightKg: number | null;
}

export interface AcsmVo2MaxInput {
  speedMetersPerMinute: number;
  gradeFraction: number;
  averageHeartRate: number;
  restingHeartRate: number;
  maxHeartRate: number;
}

export function estimateCyclingVo2Max(input: CyclingVo2MaxInput): number | null {
  if (input.weightKg == null || input.weightKg <= 0) return null;
  if (
    input.fiveMinutePowerWatts < MIN_CYCLING_POWER_WATTS ||
    input.fiveMinutePowerWatts > MAX_CYCLING_POWER_WATTS
  ) {
    return null;
  }
  return (input.fiveMinutePowerWatts / input.weightKg) * 10.8 + 7;
}

export function estimateSubmaximalAcsmVo2Max(input: AcsmVo2MaxInput): number | null {
  if (
    input.speedMetersPerMinute < MIN_SPEED_METERS_PER_MINUTE ||
    input.speedMetersPerMinute > MAX_SPEED_METERS_PER_MINUTE
  ) {
    return null;
  }
  if (input.gradeFraction < MIN_GRADE_FRACTION || input.gradeFraction > MAX_GRADE_FRACTION) {
    return null;
  }
  const heartRateReserve = input.maxHeartRate - input.restingHeartRate;
  if (heartRateReserve <= 0) return null;
  const intensityFraction = (input.averageHeartRate - input.restingHeartRate) / heartRateReserve;
  if (intensityFraction < MIN_HEART_RATE_RESERVE_FRACTION || intensityFraction >= 1) return null;

  const oxygenCost =
    input.speedMetersPerMinute < RUNNING_THRESHOLD_METERS_PER_MINUTE
      ? 0.1 * input.speedMetersPerMinute +
        1.8 * input.speedMetersPerMinute * input.gradeFraction +
        3.5
      : 0.2 * input.speedMetersPerMinute +
        0.9 * input.speedMetersPerMinute * input.gradeFraction +
        3.5;

  return oxygenCost / intensityFraction;
}

export function averageVo2MaxEstimates(estimates: readonly (number | null)[]): number | null {
  const values = estimates.filter((estimate): estimate is number => estimate != null);
  if (values.length === 0) return null;
  return values.reduce((sum, estimate) => sum + estimate, 0) / values.length;
}

export function isSupportedOutdoorVo2MaxActivityType(activityType: string): boolean {
  return [
    "running",
    "trail_running",
    "walking",
    "hiking",
    "wheelchair_run",
    "wheelchair_walk",
  ].includes(activityType);
}
```

Modify `packages/training/package.json` exports:

```json
"./derived-cardio": "./src/derived-cardio.ts"
```

- [ ] **Step 4: Run the formula tests to verify GREEN**

Run:

```bash
pnpm vitest packages/training/src/derived-cardio.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit formula helpers**

Run:

```bash
git add packages/training/src/derived-cardio.ts packages/training/src/derived-cardio.test.ts packages/training/package.json
git commit -m "Add derived cardio formulas"
git push
```

---

### Task 2: Derived Cardio Repository

**Files:**
- Create: `packages/server/src/repositories/derived-cardio-repository.ts`
- Create: `packages/server/src/repositories/derived-cardio-repository.test.ts`
- Create: `packages/server/src/repositories/derived-cardio-repository.integration.test.ts`

- [ ] **Step 1: Write failing unit tests for repository result mapping**

Create `packages/server/src/repositories/derived-cardio-repository.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DerivedCardioRepository } from "./derived-cardio-repository.ts";

function makeDb(rows: Record<string, unknown>[]) {
  return {
    execute: async () => rows,
  };
}

describe("DerivedCardioRepository", () => {
  it("averages all qualifying VO2 max estimates returned by the query", async () => {
    const repo = new DerivedCardioRepository(makeDb([{ vo2max: "40" }, { vo2max: "50" }]), {
      userId: "user-1",
      timezone: "America/Los_Angeles",
    });

    const result = await repo.getVo2MaxAverage("2026-04-28", 90);

    expect(result?.value).toBe(45);
    expect(result?.sampleCount).toBe(2);
  });

  it("returns null when no VO2 max estimates qualify", async () => {
    const repo = new DerivedCardioRepository(makeDb([]), {
      userId: "user-1",
      timezone: "America/Los_Angeles",
    });

    await expect(repo.getVo2MaxAverage("2026-04-28", 90)).resolves.toBeNull();
  });

  it("maps resting HR rows from SQL", async () => {
    const repo = new DerivedCardioRepository(makeDb([{ date: "2026-04-27", resting_hr: "52" }]), {
      userId: "user-1",
      timezone: "America/Los_Angeles",
    });

    await expect(repo.getDailyRestingHeartRates("2026-04-28", 7)).resolves.toEqual([
      { date: "2026-04-27", restingHr: 52 },
    ]);
  });
});
```

- [ ] **Step 2: Run unit tests to verify RED**

Run:

```bash
pnpm vitest packages/server/src/repositories/derived-cardio-repository.test.ts
```

Expected: FAIL with an import/module-not-found error for `derived-cardio-repository.ts`.

- [ ] **Step 3: Implement repository skeleton and SQL-backed methods**

Create `packages/server/src/repositories/derived-cardio-repository.ts`:

```ts
import { averageVo2MaxEstimates } from "@dofek/training/derived-cardio";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

const vo2MaxEstimateRowSchema = z.object({
  vo2max: z.coerce.number(),
});

const dailyRestingHeartRateRowSchema = z.object({
  date: dateStringSchema,
  resting_hr: z.coerce.number(),
});

export interface DerivedCardioContext {
  userId: string;
  timezone: string;
}

export interface DerivedVo2MaxAverage {
  value: number;
  sampleCount: number;
}

export interface DailyRestingHeartRate {
  date: string;
  restingHr: number;
}

export class DerivedCardioRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #ctx: DerivedCardioContext;

  constructor(db: Pick<Database, "execute">, ctx: DerivedCardioContext) {
    this.#db = db;
    this.#ctx = ctx;
  }

  async getVo2MaxAverage(endDate: string, days: number): Promise<DerivedVo2MaxAverage | null> {
    const rows = await executeWithSchema(
      this.#db,
      vo2MaxEstimateRowSchema,
      sql`SELECT vo2max FROM fitness.derived_vo2max_estimates
          WHERE user_id = ${this.#ctx.userId}
            AND activity_date > (${endDate}::date - ${days}::int)
            AND activity_date <= ${endDate}::date`,
    );
    const value = averageVo2MaxEstimates(rows.map((row) => row.vo2max));
    return value == null ? null : { value, sampleCount: rows.length };
  }

  async getDailyRestingHeartRates(
    endDate: string,
    days: number,
  ): Promise<DailyRestingHeartRate[]> {
    const rows = await executeWithSchema(
      this.#db,
      dailyRestingHeartRateRowSchema,
      sql`SELECT date, resting_hr
          FROM fitness.derived_resting_heart_rate
          WHERE user_id = ${this.#ctx.userId}
            AND date > (${endDate}::date - ${days}::int)
            AND date <= ${endDate}::date
          ORDER BY date ASC`,
    );
    return rows.map((row) => ({ date: row.date, restingHr: row.resting_hr }));
  }

  async getAverageRestingHeartRate(endDate: string, days: number): Promise<number | null> {
    const rows = await this.getDailyRestingHeartRates(endDate, days);
    if (rows.length === 0) return null;
    return rows.reduce((sum, row) => sum + row.restingHr, 0) / rows.length;
  }
}
```

This skeleton references SQL views that will be created in later tasks. The unit tests prove mapping and aggregation while integration tests will lock down the view SQL.

- [ ] **Step 4: Run unit tests to verify GREEN**

Run:

```bash
pnpm vitest packages/server/src/repositories/derived-cardio-repository.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing integration tests for derived views**

Create `packages/server/src/repositories/derived-cardio-repository.integration.test.ts` with this structure:

```ts
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase } from "../../../../src/db/test-helpers.ts";
import { DerivedCardioRepository } from "./derived-cardio-repository.ts";

describe("DerivedCardioRepository integration", () => {
  it("derives resting HR from sleep-window heart-rate samples", async () => {
    const ctx = await setupTestDatabase();
    const repo = new DerivedCardioRepository(ctx.db, {
      userId: TEST_USER_ID,
      timezone: "UTC",
    });

    await ctx.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
      ON CONFLICT (id) DO NOTHING`);
    await ctx.db.execute(sql`INSERT INTO fitness.sleep_session
      (provider_id, user_id, external_id, started_at, ended_at, duration_minutes, is_nap)
      VALUES ('test_provider', ${TEST_USER_ID}, 'sleep-1', '2026-04-27T23:00:00Z', '2026-04-28T07:00:00Z', 480, false)`);

    for (let index = 0; index < 30; index++) {
      await ctx.db.execute(sql`INSERT INTO fitness.metric_stream
        (recorded_at, user_id, provider_id, source_type, channel, scalar)
        VALUES (${`2026-04-28T00:${String(index).padStart(2, "0")}:00Z`}, ${TEST_USER_ID}, 'test_provider', 'api', 'heart_rate', ${50 + index % 10})`);
    }

    const rows = await repo.getDailyRestingHeartRates("2026-04-28", 7);

    expect(rows).toContainEqual({ date: "2026-04-28", restingHr: 52 });
  });

  it("returns null when resting HR has fewer than 30 sleep-window samples", async () => {
    const ctx = await setupTestDatabase();
    const repo = new DerivedCardioRepository(ctx.db, {
      userId: TEST_USER_ID,
      timezone: "UTC",
    });

    await ctx.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
      ON CONFLICT (id) DO NOTHING`);
    await ctx.db.execute(sql`INSERT INTO fitness.sleep_session
      (provider_id, user_id, external_id, started_at, ended_at, duration_minutes, is_nap)
      VALUES ('test_provider', ${TEST_USER_ID}, 'sleep-1', '2026-04-27T23:00:00Z', '2026-04-28T07:00:00Z', 480, false)`);
    await ctx.db.execute(sql`INSERT INTO fitness.metric_stream
      (recorded_at, user_id, provider_id, source_type, channel, scalar)
      VALUES ('2026-04-28T00:00:00Z', ${TEST_USER_ID}, 'test_provider', 'api', 'heart_rate', 45)`);

    await expect(repo.getAverageRestingHeartRate("2026-04-28", 7)).resolves.toBeNull();
  });
});
```

- [ ] **Step 6: Run integration tests to verify RED**

Run:

```bash
docker compose up -d db redis
docker compose ps db redis
pnpm vitest packages/server/src/repositories/derived-cardio-repository.integration.test.ts
```

Expected: FAIL because `fitness.derived_resting_heart_rate` and `fitness.derived_vo2max_estimates` do not exist yet.

- [ ] **Step 7: Commit repository skeleton and RED integration test**

Run:

```bash
git add packages/server/src/repositories/derived-cardio-repository.ts packages/server/src/repositories/derived-cardio-repository.test.ts packages/server/src/repositories/derived-cardio-repository.integration.test.ts
git commit -m "Add derived cardio repository tests"
git push
```

---

### Task 3: Derived SQL Views

**Files:**
- Create: `drizzle/_views/08_derived_resting_heart_rate.sql`
- Create: `drizzle/_views/09_derived_vo2max_estimates.sql`
- Modify: migration/view runner registration if it enumerates `_views` explicitly.

- [ ] **Step 1: Inspect view runner ordering**

Run:

```bash
rg -n "_views|v_daily_metrics|activity_summary|materialized" scripts src packages/server drizzle -g '*.ts'
```

Expected: identify whether the migration runner auto-loads `drizzle/_views/*.sql` lexicographically or uses an explicit list.

- [ ] **Step 2: Create derived resting HR view**

Create `drizzle/_views/08_derived_resting_heart_rate.sql`:

```sql
-- Derived resting HR from raw sleep-window heart-rate samples.

CREATE OR REPLACE VIEW fitness.derived_resting_heart_rate AS
WITH sleep_windows AS (
  SELECT
    user_id,
    (ended_at AT TIME ZONE 'UTC')::date AS date,
    started_at,
    ended_at
  FROM fitness.v_sleep
  WHERE is_nap = false
),
samples AS (
  SELECT
    sw.user_id,
    sw.date,
    ds.scalar AS heart_rate,
    row_number() OVER (PARTITION BY sw.user_id, sw.date ORDER BY ds.scalar ASC) AS ascending_rank,
    count(*) OVER (PARTITION BY sw.user_id, sw.date) AS sample_count
  FROM sleep_windows sw
  JOIN fitness.deduped_sensor ds
    ON ds.user_id = sw.user_id
   AND ds.channel = 'heart_rate'
   AND ds.recorded_at >= sw.started_at
   AND ds.recorded_at <= sw.ended_at
   AND ds.scalar IS NOT NULL
)
SELECT
  user_id,
  date,
  round(avg(heart_rate))::int AS resting_hr
FROM samples
WHERE sample_count >= 30
  AND ascending_rank <= greatest(ceil(sample_count * 0.10)::int, 1)
GROUP BY user_id, date;
```

- [ ] **Step 3: Create derived VO2 Max estimates view**

Create `drizzle/_views/09_derived_vo2max_estimates.sql` for per-activity VO2 Max estimates. This view must include every supported method from the approved spec before the task is complete: cycling power and outdoor running/walking/hiking ACSM estimates. Use `CREATE OR REPLACE VIEW` so the canonical view runner can re-run the file safely.

```sql
-- Derived per-activity VO2 Max estimates.

CREATE OR REPLACE VIEW fitness.derived_vo2max_estimates AS
WITH power_samples AS (
  SELECT
    ds.activity_id,
    ds.user_id,
    a.activity_type,
    (a.started_at AT TIME ZONE 'UTC')::date AS activity_date,
    ds.recorded_at,
    coalesce(ds.scalar, 0) AS power_watts,
    greatest(
      round(
        extract(epoch FROM max(ds.recorded_at) OVER (PARTITION BY ds.activity_id)
          - min(ds.recorded_at) OVER (PARTITION BY ds.activity_id))
        / nullif(count(*) OVER (PARTITION BY ds.activity_id) - 1, 0)
      )::int,
      1
    ) AS interval_seconds
  FROM fitness.deduped_sensor ds
  JOIN fitness.v_activity a ON a.id = ds.activity_id
  WHERE ds.channel = 'power'
    AND ds.activity_id IS NOT NULL
),
rolling_power AS (
  SELECT
    activity_id,
    user_id,
    activity_type,
    activity_date,
    avg(power_watts) OVER (
      PARTITION BY activity_id
      ORDER BY recorded_at
      ROWS BETWEEN 299 PRECEDING AND CURRENT ROW
    ) AS five_minute_power_watts,
    count(*) OVER (
      PARTITION BY activity_id
      ORDER BY recorded_at
      ROWS BETWEEN 299 PRECEDING AND CURRENT ROW
    ) AS sample_count,
    interval_seconds
  FROM power_samples
),
best_power AS (
  SELECT DISTINCT ON (activity_id)
    activity_id,
    user_id,
    activity_type,
    activity_date,
    five_minute_power_watts
  FROM rolling_power
  WHERE sample_count * interval_seconds >= 300
  ORDER BY activity_id, five_minute_power_watts DESC
),
activity_weight AS (
  SELECT
    bp.*,
    weight.weight_kg
  FROM best_power bp
  LEFT JOIN LATERAL (
    SELECT weight_kg
    FROM fitness.v_body_measurement bm
    WHERE bm.user_id = bp.user_id
      AND bm.weight_kg IS NOT NULL
      AND bm.recorded_at <= (bp.activity_date + interval '1 day')
    ORDER BY bm.recorded_at DESC
    LIMIT 1
  ) weight ON true
)
SELECT
  user_id,
  activity_id,
  activity_date,
  activity_type,
  'cycling_power_5m'::text AS method,
  jsonb_build_object(
    'fiveMinutePowerWatts', round(five_minute_power_watts::numeric, 1),
    'weightKg', weight_kg
  ) AS inputs,
  ((five_minute_power_watts / weight_kg) * 10.8 + 7)::real AS vo2max
FROM activity_weight
WHERE weight_kg > 0
  AND five_minute_power_watts >= 50
  AND five_minute_power_watts <= 700
  AND activity_type IN ('cycling', 'indoor_cycling', 'virtual_cycling', 'mountain_biking', 'gravel_cycling')
UNION ALL
SELECT
  user_id,
  activity_id,
  activity_date,
  activity_type,
  'acsm_speed_grade_hr_5m'::text AS method,
  inputs,
  vo2max
FROM fitness.derived_vo2max_acsm_segments
WHERE activity_type IN ('running', 'trail_running', 'walking', 'hiking', 'wheelchair_run', 'wheelchair_walk');
```

Create the referenced `fitness.derived_vo2max_acsm_segments` helper view in the same file before `fitness.derived_vo2max_estimates`. Its output columns must be:

```sql
user_id uuid,
activity_id uuid,
activity_date date,
activity_type text,
inputs jsonb,
vo2max real
```

The helper view builds five-minute segments from deduped speed, altitude, and heart-rate samples, joins the latest prior derived resting HR and `user_profile.max_hr`, applies the ACSM formulas from Task 1, and filters to the quality bounds in the spec: speed 40-450 m/min, grade -15% to 15%, HR reserve fraction 0.6 to <1.0.

- [ ] **Step 4: Run integration tests to verify GREEN for resting HR**

Run:

```bash
pnpm vitest packages/server/src/repositories/derived-cardio-repository.integration.test.ts
```

Expected: resting HR integration tests pass. If the view runner does not install new views in test DB setup, add the new view files to the runner’s explicit list and re-run.

- [ ] **Step 5: Add VO2 Max integration test**

Append to `packages/server/src/repositories/derived-cardio-repository.integration.test.ts`:

```ts
it("averages all qualifying cycling VO2 max estimates", async () => {
  const ctx = await setupTestDatabase();
  const repo = new DerivedCardioRepository(ctx.db, {
    userId: TEST_USER_ID,
    timezone: "UTC",
  });

  await ctx.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
    VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
    ON CONFLICT (id) DO NOTHING`);
  await ctx.db.execute(sql`INSERT INTO fitness.body_measurement
    (provider_id, user_id, external_id, recorded_at, weight_kg)
    VALUES ('test_provider', ${TEST_USER_ID}, 'weight-1', '2026-04-01T00:00:00Z', 75)`);

  for (const [activityId, startedAt, power] of [
    ["00000000-0000-4000-8000-000000000101", "2026-04-10T12:00:00Z", 300],
    ["00000000-0000-4000-8000-000000000102", "2026-04-11T12:00:00Z", 250],
  ] as const) {
    await ctx.db.execute(sql`INSERT INTO fitness.activity
      (id, provider_id, user_id, external_id, activity_type, started_at, ended_at)
      VALUES (${activityId}, 'test_provider', ${TEST_USER_ID}, ${activityId}, 'cycling', ${startedAt}, ${new Date(new Date(startedAt).getTime() + 300_000).toISOString()})`);
    for (let second = 0; second < 300; second++) {
      await ctx.db.execute(sql`INSERT INTO fitness.metric_stream
        (recorded_at, user_id, provider_id, source_type, channel, activity_id, scalar)
        VALUES (${new Date(new Date(startedAt).getTime() + second * 1000).toISOString()}, ${TEST_USER_ID}, 'test_provider', 'api', 'power', ${activityId}, ${power})`);
    }
  }

  await ctx.db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_activity`);
  await ctx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.deduped_sensor`);

  const result = await repo.getVo2MaxAverage("2026-04-28", 90);

  expect(result?.sampleCount).toBe(2);
  expect(result?.value).toBeCloseTo(((300 / 75) * 10.8 + 7 + (250 / 75) * 10.8 + 7) / 2, 1);
});
```

- [ ] **Step 6: Run VO2 Max integration test**

Run:

```bash
pnpm vitest packages/server/src/repositories/derived-cardio-repository.integration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit derived views**

Run:

```bash
git add drizzle/_views/08_derived_resting_heart_rate.sql drizzle/_views/09_derived_vo2max_estimates.sql packages/server/src/repositories/derived-cardio-repository.integration.test.ts
git commit -m "Add derived cardio SQL views"
git push
```

---

### Task 4: Remove Stored Columns From Schema and View

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `drizzle/_views/04_v_daily_metrics.sql`
- Add: `drizzle/0007_remove_resting_hr_vo2max.sql`
- Modify tests referencing daily metrics schema/view.

- [ ] **Step 1: Write failing schema/view test**

Find an existing DB schema/view integration test that introspects `fitness.v_daily_metrics`. If none exists, add `src/db/daily-metrics-schema.integration.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setupTestDatabase } from "./test-helpers.ts";

describe("daily metrics schema", () => {
  it("does not expose stored resting HR or VO2 Max columns", async () => {
    const ctx = await setupTestDatabase();

    const columns = await ctx.db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'fitness'
        AND table_name = 'daily_metrics'
      ORDER BY column_name
    `);

    expect(columns.map((row) => row.column_name)).not.toContain("resting_hr");
    expect(columns.map((row) => row.column_name)).not.toContain("vo2max");
  });
});
```

- [ ] **Step 2: Run schema test to verify RED**

Run:

```bash
pnpm vitest src/db/daily-metrics-schema.integration.test.ts
```

Expected: FAIL because both columns still exist.

- [ ] **Step 3: Remove columns from Drizzle schema**

In `src/db/schema.ts`, remove these fields from `dailyMetrics`:

```ts
restingHr: integer("resting_hr"),
vo2max: real("vo2max"),
```

- [ ] **Step 4: Update canonical daily metrics view**

In `drizzle/_views/04_v_daily_metrics.sql`, remove these selected expressions:

```sql
(SELECT r.resting_hr ... ) AS resting_hr,
(SELECT r.vo2max ... ) AS vo2max,
```

Keep all other columns and indexes unchanged.

- [ ] **Step 5: Add manual migration**

Create `drizzle/0007_remove_resting_hr_vo2max.sql`:

```sql
DROP MATERIALIZED VIEW IF EXISTS fitness.v_daily_metrics;

ALTER TABLE fitness.daily_metrics DROP COLUMN IF EXISTS resting_hr;
ALTER TABLE fitness.daily_metrics DROP COLUMN IF EXISTS vo2max;
```

If the migration runner expects `--> statement-breakpoint`, add one after each statement:

```sql
DROP MATERIALIZED VIEW IF EXISTS fitness.v_daily_metrics;
--> statement-breakpoint
ALTER TABLE fitness.daily_metrics DROP COLUMN IF EXISTS resting_hr;
--> statement-breakpoint
ALTER TABLE fitness.daily_metrics DROP COLUMN IF EXISTS vo2max;
```

- [ ] **Step 6: Run migration locally**

Run:

```bash
pnpm migrate
```

Expected: migration applies and canonical views are recreated.

- [ ] **Step 7: Run schema test to verify GREEN**

Run:

```bash
pnpm vitest src/db/daily-metrics-schema.integration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit schema migration**

Run:

```bash
git add src/db/schema.ts drizzle/_views/04_v_daily_metrics.sql drizzle/0007_remove_resting_hr_vo2max.sql src/db/daily-metrics-schema.integration.test.ts
git commit -m "Remove stored resting HR and VO2 max columns"
git push
```

---

### Task 5: Stop Provider Persistence of Removed Metrics

**Files:**
- Modify provider files listed in File Structure.
- Modify provider tests that currently assert `restingHr` or `vo2max` persistence.

- [ ] **Step 1: Run targeted provider tests to get RED from schema removal**

Run:

```bash
pnpm vitest src/providers/apple-health/db-insertion.test.ts packages/server/src/routers/health-kit-sync.test.ts packages/server/src/repositories/health-kit-sync-repository.test.ts src/providers/garmin.test.ts src/providers/oura.test.ts src/providers/ultrahuman-extra.test.ts src/providers/zwift.test.ts
```

Expected: FAIL where code still writes `restingHr` or `vo2max` to `dailyMetrics`.

- [ ] **Step 2: Remove Apple Health daily persistence for resting HR and VO2 Max**

In `src/providers/apple-health/db-insertion.ts`, remove the daily metric type entries and switch cases:

```ts
case "HKQuantityTypeIdentifierRestingHeartRate":
  row.restingHr = Math.round(value);
  break;
case "HKQuantityTypeIdentifierVO2Max":
  row.vo2max = value;
  break;
```

Update tests so parsed HealthKit records can still be parsed, but DB insertion no longer expects `restingHr` or `vo2max`.

- [ ] **Step 3: Remove HealthKit sync router/repository fields**

In these files, remove `HKQuantityTypeIdentifierRestingHeartRate` and `HKQuantityTypeIdentifierVO2Max` from daily metric mappings:

```text
packages/server/src/routers/health-kit-sync-schemas.ts
packages/server/src/routers/health-kit-sync-processors.ts
packages/server/src/repositories/health-kit-sync-repository.ts
```

Remove `restingHr` and `vo2max` accumulator fields from the daily metric accumulator types and insert/update field lists. Keep raw `heart_rate` metric stream handling untouched.

- [ ] **Step 4: Remove provider VO2 Max persistence**

Edit these files:

`src/providers/garmin.ts`

```ts
// Remove vo2max variable and remove vo2max from insert/update values.
```

`src/providers/oura/parsing.ts`

```ts
// Remove vo2max from ParsedOuraDailyMetrics if no production consumer remains.
```

`src/providers/oura/sync-steps.ts`

```ts
// Do not include vo2max: parsed.vo2max in insert/update values.
```

`src/providers/ultrahuman.ts`

```ts
// Do not set daily.vo2max and do not use it to decide whether to upsert daily metrics.
```

`src/providers/zwift.ts`

```ts
// Remove the power_curve sync block that writes curve.vo2Max into dailyMetrics.
// Keep any unrelated power/activity sync behavior unchanged.
```

- [ ] **Step 5: Update provider tests**

Change tests that currently assert stored VO2 Max to assert the provider value is ignored. Example replacement pattern:

```ts
expect(daily.vo2max).toBeUndefined();
```

becomes:

```ts
expect(Object.hasOwn(daily, "vo2max")).toBe(false);
```

For integration tests that query DB rows, remove selected `vo2max` columns from SQL and assert the row still exists for other metrics.

- [ ] **Step 6: Run targeted provider tests to verify GREEN**

Run:

```bash
pnpm vitest src/providers/apple-health/db-insertion.test.ts packages/server/src/routers/health-kit-sync.test.ts packages/server/src/repositories/health-kit-sync-repository.test.ts src/providers/garmin.test.ts src/providers/oura.test.ts src/providers/ultrahuman-extra.test.ts src/providers/zwift.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit provider cleanup**

Run:

```bash
git add src/providers packages/server/src/routers/health-kit-sync-schemas.ts packages/server/src/routers/health-kit-sync-processors.ts packages/server/src/repositories/health-kit-sync-repository.ts
git commit -m "Stop persisting provider resting HR and VO2 max"
git push
```

---

### Task 6: Update Daily Metrics APIs and Clients

**Files:**
- Modify: `packages/server/src/repositories/daily-metrics-repository.ts`
- Modify: `packages/server/src/routers/daily-metrics.ts`
- Modify: `packages/web/src/pages/Dashboard.tsx`
- Modify: `packages/web/src/pages/BodyPage.tsx`
- Modify: `packages/mobile/app/(tabs)/recovery.tsx`
- Modify tests and local schemas that expect `resting_hr` or `vo2max`.

- [ ] **Step 1: Run daily metrics tests to get RED**

Run:

```bash
pnpm vitest packages/server/src/repositories/daily-metrics-repository.test.ts packages/server/src/routers/daily-metrics.test.ts packages/web/src/pages/Dashboard.test.tsx packages/mobile/app/'(tabs)'/recovery.test.tsx
```

Expected: FAIL on schemas or fixtures expecting `resting_hr` from `fitness.v_daily_metrics`.

- [ ] **Step 2: Remove stored resting HR from daily metrics repository schemas**

In `packages/server/src/repositories/daily-metrics-repository.ts`, remove:

```ts
resting_hr: z.number().nullable(),
avg_resting_hr: z.coerce.number().nullable(),
stddev_resting_hr: z.coerce.number().nullable(),
latest_resting_hr: z.coerce.number().nullable(),
```

Remove `resting_hr` from `getTrends()` SQL stats/latest sections. Keep `hrv` baseline; remove `resting_hr` from `getHrvBaseline()` output or rename that endpoint to HRV-only if no client needs derived resting HR there.

- [ ] **Step 3: Update client chart data**

In web/mobile recovery dashboards, remove chart bindings that expect `resting_hr` from `dailyMetrics.list` and `dailyMetrics.trends`. Resting HR display moves to the derived-cardio API path wired in Task 7.

The immediate safe state is:

```ts
const hrvTrend = metrics.map((row) => ({ date: row.date, value: row.hrv }));
```

with no `resting_hr` series coming from daily metrics.

- [ ] **Step 4: Update tests and fixtures**

Remove `resting_hr` and `vo2max` keys from daily metrics fixtures. Where tests assert “oxygen/skin temp” dashboard behavior, keep those assertions unchanged.

- [ ] **Step 5: Run daily metrics tests**

Run:

```bash
pnpm vitest packages/server/src/repositories/daily-metrics-repository.test.ts packages/server/src/routers/daily-metrics.test.ts packages/web/src/pages/Dashboard.test.tsx packages/mobile/app/'(tabs)'/recovery.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit API/client cleanup**

Run:

```bash
git add packages/server/src/repositories/daily-metrics-repository.ts packages/server/src/routers/daily-metrics.ts packages/web packages/mobile
git commit -m "Remove resting HR from daily metrics APIs"
git push
```

---

### Task 7: Wire Derived Metrics Into Healthspan

**Files:**
- Modify: `packages/server/src/routers/healthspan-query.ts`
- Modify: `packages/server/src/routers/healthspan.ts`
- Modify: `packages/server/src/routers/healthspan.test.ts`
- Modify: `packages/server/src/routers/healthspan.integration.test.ts`

- [ ] **Step 1: Write failing healthspan unit test for derived values**

In `packages/server/src/routers/healthspan.test.ts`, add or update a test so the raw row contains derived fields:

```ts
it("scores derived resting HR and averaged derived VO2 max", async () => {
  mockFetchHealthspanRawData.mockResolvedValue({
    avg_sleep_min: 480,
    bedtime_stddev_min: 30,
    avg_resting_hr: 52,
    avg_steps: 10_000,
    latest_vo2max: 48,
    weekly_aerobic_min: 180,
    weekly_high_intensity_min: 45,
    sessions_per_week: 2,
    weight_kg: 75,
    body_fat_pct: 18,
    weekly_history: [],
  });

  const result = await caller.healthspan.score({ weeks: 12, endDate: "2026-04-28" });

  expect(result.metrics.find((metric) => metric.name === "Resting Heart Rate")?.value).toBe(52);
  expect(result.metrics.find((metric) => metric.name === "VO2 Max")?.value).toBe(48);
});
```

- [ ] **Step 2: Run healthspan unit tests**

Run:

```bash
pnpm vitest packages/server/src/routers/healthspan.test.ts
```

Expected: this may pass if row shape is unchanged, but integration still fails until query stops reading removed columns.

- [ ] **Step 3: Update healthspan query to use derived repository**

In `packages/server/src/routers/healthspan-query.ts`, import `DerivedCardioRepository` and change `fetchHealthspanRawData()` to:

1. Query sleep, steps, zone time, strength, and body data without `resting_hr` or `vo2max` from `v_daily_metrics`.
2. In TypeScript after the SQL row returns, call:

```ts
const derivedRepo = new DerivedCardioRepository(ctx.db, {
  userId: ctx.userId,
  timezone: ctx.timezone,
});
const [derivedRestingHr, derivedVo2Max] = await Promise.all([
  derivedRepo.getAverageRestingHeartRate(endDate, totalDays),
  derivedRepo.getVo2MaxAverage(endDate, totalDays),
]);
```

3. Return:

```ts
{
  ...row,
  avg_resting_hr: derivedRestingHr,
  latest_vo2max: derivedVo2Max?.value ?? null,
}
```

For `weekly_history`, build weekly rows by combining:

```ts
steps by week from fitness.v_daily_metrics
derived resting HR by week from DerivedCardioRepository.getDailyRestingHeartRates()
derived VO2 Max by activity_date week from fitness.derived_vo2max_estimates
```

- [ ] **Step 4: Replace HR zone lateral resting HR lookup**

In the `hr_zone_time` CTE, replace the lateral lookup from `fitness.v_daily_metrics dm2.resting_hr` with `fitness.derived_resting_heart_rate drhr.resting_hr`:

```sql
JOIN LATERAL (
  SELECT drhr.resting_hr
  FROM fitness.derived_resting_heart_rate drhr
  WHERE drhr.user_id = asum.user_id
    AND drhr.date <= (asum.started_at AT TIME ZONE ${ctx.timezone})::date
  ORDER BY drhr.date DESC
  LIMIT 1
) rhr2 ON true
```

- [ ] **Step 5: Run healthspan tests**

Run:

```bash
pnpm vitest packages/server/src/routers/healthspan.test.ts packages/server/src/routers/healthspan.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit healthspan wiring**

Run:

```bash
git add packages/server/src/routers/healthspan-query.ts packages/server/src/routers/healthspan.ts packages/server/src/routers/healthspan.test.ts packages/server/src/routers/healthspan.integration.test.ts
git commit -m "Use derived cardio metrics in healthspan"
git push
```

---

### Task 8: Move Cycling VO2 Max Display Server-Side

**Files:**
- Modify: `packages/server/src/routers/power.ts`
- Modify: `packages/server/src/repositories/power-repository.ts`
- Modify: `packages/web/src/routes/training/cycling.tsx`
- Modify tests for power/cycling page.

- [ ] **Step 1: Write failing power repository test**

In `packages/server/src/repositories/power-repository.test.ts`, add:

```ts
it("returns derived VO2 max from five-minute power and latest weight", async () => {
  const repo = makePowerRepositoryWithRows({
    powerCurveRows: [{ durationSeconds: 300, bestPower: 300, activityDate: "2026-04-10" }],
    bodyRows: [{ weight_kg: "75" }],
  });

  const result = await repo.getCyclingVo2Max(90);

  expect(result).toBeCloseTo(50.2, 1);
});
```

If the existing test helper shape differs, create a narrow mock DB that returns the rows needed by the new method.

- [ ] **Step 2: Implement server method**

In `packages/server/src/repositories/power-repository.ts`, add:

```ts
async getCyclingVo2Max(days: number): Promise<number | null> {
  const curve = await this.getPowerCurve(days);
  const fiveMinute = curve.points.find((point) => point.durationSeconds === 300);
  if (!fiveMinute) return null;
  const rows = await executeWithSchema(
    this.#db,
    z.object({ weight_kg: z.coerce.number().nullable() }),
    sql`SELECT weight_kg
        FROM fitness.v_body_measurement
        WHERE user_id = ${this.#userId}
          AND weight_kg IS NOT NULL
        ORDER BY recorded_at DESC
        LIMIT 1`,
  );
  return estimateCyclingVo2Max({
    fiveMinutePowerWatts: fiveMinute.bestPower,
    weightKg: rows[0]?.weight_kg ?? null,
  });
}
```

Import `estimateCyclingVo2Max` from `@dofek/training/derived-cardio`.

- [ ] **Step 3: Add router endpoint**

In `packages/server/src/routers/power.ts`, add:

```ts
cyclingVo2Max: cachedProtectedQuery(CacheTTL.LONG)
  .input(z.object({ days: z.number().default(90) }))
  .query(async ({ ctx, input }) => {
    const repo = new PowerRepository(ctx.db, ctx.userId, ctx.timezone);
    return repo.getCyclingVo2Max(input.days);
  }),
```

- [ ] **Step 4: Update cycling page**

In `packages/web/src/routes/training/cycling.tsx`, remove local `estimateVo2max()` and body weight query usage for VO2 Max. Replace with:

```ts
const recentVo2max = trpc.power.cyclingVo2Max.useQuery({ days });
const seasonVo2max = trpc.power.cyclingVo2Max.useQuery({ days: 365 });
```

Pass `recentVo2max.data ?? null` and `seasonVo2max.data ?? null` into the existing `DerivedRow`.

- [ ] **Step 5: Run power and cycling tests**

Run:

```bash
pnpm vitest packages/server/src/repositories/power-repository.test.ts packages/server/src/routers/power.test.ts packages/web/src/routes/training/running.test.tsx
```

Expected: PASS. If there is no `power.test.ts`, run the nearest power router test discovered by `rg -n "powerCurve|powerRouter" packages/server/src`.

- [ ] **Step 6: Commit server-side cycling display**

Run:

```bash
git add packages/server/src/repositories/power-repository.ts packages/server/src/routers/power.ts packages/web/src/routes/training/cycling.tsx
git commit -m "Serve cycling VO2 max from server"
git push
```

---

### Task 9: Documentation and Final Verification

**Files:**
- Modify: `docs/schema.md`
- Modify: generated schema docs if repository practice requires it.

- [ ] **Step 1: Update schema documentation**

In `docs/schema.md`, remove the `daily_metrics.vo2max` row and any `resting_hr` entry that describes it as stored provider data. Add:

```md
### Derived cardio metrics

Resting heart rate and VO2 Max are derived server-side. Resting heart rate comes from low-percentile sleep-window heart-rate samples. VO2 Max is averaged from qualifying activity-level estimates based on transparent public equations. Provider VO2 Max values are ignored for canonical scoring.
```

- [ ] **Step 2: Run format/lint**

Run:

```bash
pnpm format
pnpm lint
```

Expected: PASS.

- [ ] **Step 3: Run changed tests**

Run:

```bash
docker compose up -d db redis
docker compose ps db redis
pnpm test:changed
```

Expected: PASS.

- [ ] **Step 4: Run typechecks**

Run:

```bash
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd ../web && pnpm tsc --noEmit
```

Expected: all commands exit 0.

- [ ] **Step 5: Run focused integration suites**

Run:

```bash
pnpm vitest packages/server/src/repositories/derived-cardio-repository.integration.test.ts packages/server/src/routers/healthspan.integration.test.ts src/db/daily-metrics-schema.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit docs and verification fixes**

Run:

```bash
git add docs/schema.md docs/schema.dbml docs/schema.puml
git commit -m "Document derived cardio metric provenance"
git push
```

- [ ] **Step 7: Final report**

Include:

```text
Root modeling change: resting HR and VO2 Max are no longer stored daily metric columns.
Direct fix: removed columns and provider writes, added derived server-side calculations.
Validation: list lint, changed tests, typechecks, focused integration tests.
Remaining risk: users without raw HR/power/speed/weight inputs may see missing derived values.
```
