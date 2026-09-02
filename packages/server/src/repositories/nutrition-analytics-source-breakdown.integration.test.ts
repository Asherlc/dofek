import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { NutritionAnalyticsRepository } from "./nutrition-analytics-repository.ts";

const USER_ID = "00000000-0000-4000-8000-000000002136";

describe("nutrition analytics source breakdown with Postgres", () => {
  let context: TestContext;
  let dates: string[];

  beforeAll(async () => {
    context = await setupTestDatabase();
    const [today] = await executeWithSchema(
      context.db,
      z.object({ date: dateStringSchema }),
      sql`SELECT CURRENT_DATE::text AS date`,
    );
    if (!today) throw new Error("Postgres did not return CURRENT_DATE");
    dates = Array.from({ length: 4 }, (_, index) => {
      const date = new Date(`${today.date}T12:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - (3 - index));
      return date.toISOString().slice(0, 10);
    });

    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name, email)
      VALUES (${USER_ID}, 'Nutrition source breakdown', 'nutrition-2136@example.com')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name)
      VALUES
        ('nutrition-2136-manual', 'Manual Food'),
        ('nutrition-2136-cronometer', 'Cronometer'),
        ('nutrition-2136-other-itemized', 'Other Itemized Source'),
        ('nutrition-2136-supplements', 'Dofek Supplements')
      ON CONFLICT (id) DO NOTHING
    `);

    await addFoodEntry({
      date: dates[0] ?? "",
      providerId: "nutrition-2136-manual",
      grain: "itemized",
      foodName: "Breakfast",
      vitaminC: 40,
    });
    await addTakenSupplement(dates[0] ?? "", 10);

    await addFoodEntry({
      date: dates[1] ?? "",
      providerId: "nutrition-2136-cronometer",
      grain: "daily_aggregate",
      foodName: null,
      vitaminC: 60,
    });

    await addFoodEntry({
      date: dates[2] ?? "",
      providerId: "nutrition-2136-manual",
      grain: "itemized",
      foodName: "Lunch",
      vitaminC: 50,
    });
    await addFoodEntry({
      date: dates[2] ?? "",
      providerId: "nutrition-2136-cronometer",
      grain: "daily_aggregate",
      foodName: null,
      vitaminC: 100,
    });

    await addFoodEntry({
      date: dates[3] ?? "",
      providerId: "nutrition-2136-manual",
      grain: "itemized",
      foodName: "Dinner",
      vitaminC: 40,
    });
    await addFoodEntry({
      date: dates[3] ?? "",
      providerId: "nutrition-2136-other-itemized",
      grain: "itemized",
      foodName: "Other dinner",
      vitaminC: 60,
    });
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  async function addFoodEntry(input: {
    date: string;
    providerId: string;
    grain: "itemized" | "daily_aggregate";
    foodName: string | null;
    vitaminC: number;
  }): Promise<void> {
    await context.db.execute(sql`
      WITH entry AS (
        INSERT INTO fitness.food_entry (
          user_id,
          provider_id,
          date,
          nutrition_grain,
          food_name,
          confirmed
        )
        VALUES (
          ${USER_ID},
          ${input.providerId},
          ${input.date}::date,
          ${input.grain}::fitness.nutrition_entry_grain,
          ${input.foodName},
          TRUE
        )
        RETURNING id
      )
      INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
      SELECT id, 'vitamin_c', ${input.vitaminC} FROM entry
    `);
  }

  async function addTakenSupplement(date: string, vitaminC: number): Promise<void> {
    await context.db.execute(sql`
      WITH schedule AS (
        INSERT INTO fitness.supplement (user_id)
        VALUES (${USER_ID})
        RETURNING id
      ),
      definition AS (
        INSERT INTO fitness.supplement_definition (
          supplement_id,
          name,
          effective_from
        )
        SELECT id, 'Vitamin C', ${date}::date
        FROM schedule
        RETURNING id, supplement_id
      ),
      nutrient AS (
        INSERT INTO fitness.supplement_definition_nutrient (
          definition_id,
          nutrient_id,
          amount
        )
        SELECT id, 'vitamin_c', ${vitaminC}
        FROM definition
      )
      INSERT INTO fitness.supplement_dose_event (
        user_id,
        supplement_id,
        definition_id,
        provider_id,
        scheduled_date,
        status,
        recorded_at
      )
      SELECT
        ${USER_ID},
        supplement_id,
        id,
        'nutrition-2136-supplements',
        ${date}::date,
        'taken',
        NOW()
      FROM definition
    `);
  }

  it("separates canonical nutrient contributions by intake type and source", async () => {
    const repository = new NutritionAnalyticsRepository(context.db, USER_ID);

    const nutrients = await repository.getMicronutrientSafetyReview(30);
    const vitaminC = nutrients.find((nutrient) => nutrient.toDetail().nutrientId === "vitamin_c");

    expect(vitaminC?.toDetail()).toMatchObject({
      intake: {
        totalDailyAverage: 53.3,
        foodDailyAverage: 30,
        providerDailyTotalAverage: 20,
        supplementDailyAverage: 3.3,
        daysTracked: 3,
      },
      sourceBreakdown: [
        {
          providerId: "nutrition-2136-manual",
          sourceLabel: "Manual Food",
          intakeType: "itemized_food",
          dailyAverageContribution: 30,
          daysTracked: 2,
        },
        {
          providerId: "nutrition-2136-cronometer",
          sourceLabel: "Cronometer",
          intakeType: "provider_daily_total",
          dailyAverageContribution: 20,
          daysTracked: 1,
        },
        {
          providerId: "nutrition-2136-supplements",
          sourceLabel: "nutrition-2136-supplements",
          intakeType: "supplement",
          dailyAverageContribution: 3.3,
          daysTracked: 1,
        },
      ],
    });
  });

  it("reports selected-window completeness and both resolved and unresolved overlap", async () => {
    const repository = new NutritionAnalyticsRepository(context.db, USER_ID);

    await expect(repository.getMicronutrientDataQuality(30)).resolves.toEqual({
      selectedWindowDays: 30,
      daysWithData: 4,
      usableDays: 3,
      overlapDays: 2,
      conflictDays: 1,
      completenessPercent: 10,
      sourceLabels: [
        "Cronometer",
        "Manual Food",
        "Other Itemized Source",
        "nutrition-2136-supplements",
      ],
      contributingSourceLabels: ["Cronometer", "Manual Food", "nutrition-2136-supplements"],
      excludedSourceLabels: ["Cronometer", "Manual Food", "Other Itemized Source"],
    });
  });
});
