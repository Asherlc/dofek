import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { activityRowSchema, nutritionRowSchema } from "../insights/schemas.ts";
import type { Insight } from "../insights/types.ts";
import {
  createClickHouseTestRawSensorStore,
  executeClickHouseTestCommand,
} from "../routers/clickhouse-integration-test-helpers.ts";
import { InsightsRepository } from "./insights-repository.ts";

const zone = "America/Los_Angeles";
const endDate = "2026-03-10";
const days = 20;

function insightPoints(insights: Insight[], id: string) {
  return insights.find((candidate) => candidate.id === id)?.dataPoints;
}

/** Ascending YYYY-MM-DD dates, matching the ORDER BY of the queries under test. */
function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

describe("InsightsRepository exact local dates", () => {
  let context: TestContext;
  let repository: InsightsRepository;

  beforeAll(async () => {
    context = await setupTestDatabase();
    const db = context.db;
    await db.execute(sql`INSERT INTO fitness.provider (id, name, user_id) VALUES
      ('whoop', 'WHOOP', ${TEST_USER_ID}),
      ('dofek', 'Dofek', ${TEST_USER_ID})
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO fitness.provider_priority
      (provider_id, priority, sleep_priority, recovery_priority, body_priority, daily_activity_priority)
      VALUES ('whoop', 10, 10, 10, 10, 10), ('dofek', 20, 20, 20, 20, 20)
      ON CONFLICT (provider_id) DO UPDATE SET
        priority = EXCLUDED.priority,
        sleep_priority = EXCLUDED.sleep_priority,
        recovery_priority = EXCLUDED.recovery_priority,
        body_priority = EXCLUDED.body_priority,
        daily_activity_priority = EXCLUDED.daily_activity_priority`);

    // Vary HRV and sleep with the calendar index to produce qualifying correlations.
    await db.execute(sql`INSERT INTO fitness.daily_metrics
      (date, provider_id, user_id, hrv, steps, spo2_avg, source_name)
      SELECT d::date, 'whoop', ${TEST_USER_ID}::uuid,
        40 + (d::date - DATE '2026-02-17')::int,
        8000,
        null,
        'fixture'
      FROM generate_series(DATE '2026-02-17', DATE '2026-03-12', INTERVAL '1 day') d`);

    // Started at 05:00Z, so the stored night key (started_at - 6h) is the day
    // BEFORE the local wake date. This distinguishes the two date bases.
    await db.execute(sql`INSERT INTO fitness.sleep_session
      (id, user_id, provider_id, external_id, started_at, ended_at, duration_minutes,
       deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct,
       staging_available, sleep_type, is_nap, timezone, local_time_source, source_name)
      SELECT gen_random_uuid(), ${TEST_USER_ID}::uuid, 'whoop', 'insights-sleep-' || i,
        (DATE '2026-02-19' + i)::timestamp + INTERVAL '5 hours',
        CASE WHEN i <> 19 THEN
          (DATE '2026-02-19' + i)::timestamp + INTERVAL '5 hours' + ((400 + i) || ' minutes')::interval
        END,
        400 + i, 60, 80, 200, 40, 80 + i,
        true, 'sleep', false, 'America/Los_Angeles', 'device_timezone', 'WHOOP'
      FROM generate_series(-1, 20) AS i`);

    // Started at 02:00Z the following UTC day, which is the evening of the
    // intended local date in America/Los_Angeles.
    await db.execute(sql`INSERT INTO fitness.activity
      (id, user_id, provider_id, external_id, canonical_type, provider_type,
       started_at, ended_at, local_time_source)
      SELECT gen_random_uuid(), ${TEST_USER_ID}::uuid, 'whoop', 'insights-activity-' || i,
        'cycling', 'cycling',
        (DATE '2026-02-20' + i)::timestamp + INTERVAL '2 hours',
        (DATE '2026-02-20' + i)::timestamp + INTERVAL '2 hours' + ((30 + i) || ' minutes')::interval,
        'unknown'
      FROM generate_series(-2, 21) AS i`);

    await db.execute(sql`INSERT INTO fitness.food_entry
      (id, user_id, provider_id, external_id, date, nutrition_grain, meal, food_name, started_at)
      SELECT ('a1000000-0000-4000-8000-' || lpad((i + 3)::text, 12, '0'))::uuid,
        ${TEST_USER_ID}::uuid, 'dofek', 'insights-food-' || i,
        (DATE '2026-02-19' + i)::date, 'itemized', 'lunch', 'Fixture', null
      FROM generate_series(-1, 20) AS i`);
    await db.execute(sql`INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
      SELECT fe.id, 'calories', 2000
      FROM generate_series(-1, 20) AS i
      JOIN fitness.food_entry fe ON fe.external_id = 'insights-food-' || i
      JOIN fitness.nutrient n ON n.id = 'calories'`);
    const sensorStore = await createClickHouseTestRawSensorStore(context);
    for (const model of ["v_sleep", "daily_sleep", "v_daily_metrics"]) {
      await executeClickHouseTestCommand(
        context,
        `REBUILD TEST ANALYTICS TABLE analytics.${model}`,
      );
    }
    repository = new InsightsRepository(context.db, TEST_USER_ID, zone, sensorStore);
  }, 180_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("aligns activity and sleep to exact local dates across both window boundaries", async () => {
    const insights = await repository.computeInsights(days, endDate);
    const activityPoints = insightPoints(insights, "exercise-dur-sleep-eff");
    const sleepPoints = insightPoints(insights, "sleep-dur-hrv");

    expect(activityPoints).toHaveLength(19);
    expect(activityPoints?.[0]).toEqual({ date: "2026-02-19", x: 30, y: 81 });
    expect(activityPoints?.at(-1)).toEqual({ date: "2026-03-09", x: 48, y: 99 });
    expect(sleepPoints).toHaveLength(19);
    expect(sleepPoints?.[0]).toEqual({ date: "2026-02-19", x: 400, y: 43 });
    expect(sleepPoints?.at(-1)).toEqual({ date: "2026-03-09", x: 418, y: 61 });
  });

  it.each([
    {
      label: "finite 20-day window",
      windowDays: days,
      activityDates: dateRange("2026-02-19", "2026-03-10"),
      foodDates: dateRange("2026-02-19", "2026-03-10"),
    },
    {
      label: "all-time window",
      windowDays: null,
      activityDates: dateRange("2026-02-17", "2026-03-10"),
      foodDates: dateRange("2026-02-18", "2026-03-10"),
    },
  ])(
    "returns native query row dates within the $label",
    async ({ windowDays, activityDates, foodDates }) => {
      const execute = vi.spyOn(context.db, "execute");
      try {
        await repository.computeInsights(windowDays, endDate);

        const queries = await Promise.all(execute.mock.results.map(({ value }) => value));
        const rows = queries.flat();
        const activity = rows
          .filter((row) => "canonical_type" in row)
          .map((row) => activityRowSchema.parse(row).date);
        const food = rows
          .filter((row) => "calories" in row)
          .map((row) => nutritionRowSchema.parse(row).date);

        expect(activity).toEqual(activityDates);
        expect(food).toEqual(foodDates);
      } finally {
        execute.mockRestore();
      }
    },
  );
});
