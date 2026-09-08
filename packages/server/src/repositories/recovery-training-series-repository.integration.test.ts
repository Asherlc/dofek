import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { recoveryTrainingSeriesOutputSchema } from "../mcp/recovery-training-series-output.ts";
import { DailyMetricsRepository } from "./daily-metrics-repository.ts";
import { FoodRepository } from "./food-repository.ts";
import { RecoveryTrainingSeriesRepository } from "./recovery-training-series-repository.ts";
import { restingHeartRateValuesCte } from "./resting-heart-rate-query.ts";

describe("RecoveryTrainingSeriesRepository with canonical Postgres sources", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("aligns observed health and nutrition with an adjacent no-logging date", async () => {
    const userId = randomUUID();
    const providerId = `recovery-series-${userId}`;
    const foodEntryId = randomUUID();
    const observedDate = "2026-02-27";
    const missingDate = "2026-02-28";
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES (${userId}::uuid, 'Recovery series fixture', ${`${userId}@example.com`})`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES (${providerId}, 'Recovery series fixture', ${userId}::uuid)`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.daily_metrics (
            provider_id, user_id, date, hrv, respiratory_rate_avg, steps
          ) VALUES (${providerId}, ${userId}::uuid, ${observedDate}::date, 52, 14, 8000)`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.food_entry (
        id, provider_id, user_id, date, nutrition_grain, food_name, meal, confirmed
      ) VALUES (
        ${foodEntryId}::uuid, ${providerId}, ${userId}::uuid, ${observedDate}::date,
        'itemized', 'Only logged snack', 'snack', true
      )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
          VALUES (${foodEntryId}::uuid, 'calories', 150)`,
    );
    const repository = new RecoveryTrainingSeriesRepository(
      {
        dailyMetrics: new DailyMetricsRepository(context.db, userId, "UTC"),
        nutrition: new FoodRepository(context.db, userId, "UTC"),
      },
      "UTC",
    );

    const result = await repository.listRange(observedDate, missingDate, ["health", "nutrition"]);

    expect(() => recoveryTrainingSeriesOutputSchema.parse({ result })).not.toThrow();

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      date: observedDate,
      health: { hrv: { value: 52, status: "observed" } },
      nutrition: { total_calories: 150, logging_completeness: "unknown_completeness" },
    });
    expect(result.rows[1]).toMatchObject({
      date: missingDate,
      health: { hrv: { value: null, status: "missing" } },
      nutrition: { total_calories: null, logging_completeness: "no_logging" },
    });
  });

  it("retains a resting-HR-only date without manufacturing other health values", async () => {
    const userId = randomUUID();
    const date = "2026-04-02";
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES (${userId}::uuid, 'RHR-only fixture', ${`${userId}@example.com`})`,
    );
    const dailyMetrics = new DailyMetricsRepository(context.db, userId, "UTC");
    const repository = new RecoveryTrainingSeriesRepository(
      {
        dailyMetrics: {
          listRange: (startDate, endDate) =>
            dailyMetrics.listRange(
              startDate,
              endDate,
              restingHeartRateValuesCte([{ date, resting_hr: 48 }]),
            ),
        },
      },
      "UTC",
    );

    const result = await repository.listRange(date, date, ["health"]);

    expect(result.rows[0]?.health).toMatchObject({
      hrv: { value: null, status: "missing", source_providers: [] },
      resting_hr: {
        value: 48,
        status: "observed",
        value_kind: "calculated_from_deduped_samples",
        source_providers: [],
      },
    });
  });
});
