import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { FoodReadRepository } from "../repositories/food-read-repository.ts";
import { toDayNutritionPreview } from "./day-nutrition-output.ts";

describe("day nutrition preview with decimal calorie nutrients", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name)
      VALUES ('preview-decimals', 'Preview Decimals')
    `);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it.each([
    { date: "2026-09-08", amount: 300.25, roundedTotal: 300 },
    { date: "2026-09-09", amount: 0.25, roundedTotal: 0 },
  ])(
    "renders a full meal share when $amount calories round to $roundedTotal",
    async ({ date, amount, roundedTotal }) => {
      await context.db.execute(
        sql`DELETE FROM fitness.food_entry WHERE provider_id = 'preview-decimals' AND date = ${date}::date`,
      );
      const id = crypto.randomUUID();
      await context.db.execute(sql`
      INSERT INTO fitness.food_entry (id, user_id, provider_id, date, meal, food_name, nutrition_grain, confirmed)
      VALUES (${id}, ${TEST_USER_ID}, 'preview-decimals', ${date}::date, 'breakfast', 'Decimal portion', 'itemized', true)
    `);
      await context.db.execute(sql`
      INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
      VALUES (${id}, 'calories', ${amount})
    `);

      const repository = new FoodReadRepository(context.db, TEST_USER_ID, "UTC");
      const { summary } = await repository.nutritionTotalsByDate(date);
      expect(summary?.calories).toBe(roundedTotal);
      expect(summary?.mealCalories.breakfast).toBe(amount);
      if (!summary) throw new Error("Expected canonical nutrition totals");

      expect(toDayNutritionPreview(date, summary).meals[0]).toEqual({
        meal: "breakfast",
        calories: amount,
        share_percentage: 100,
      });
    },
  );
});
