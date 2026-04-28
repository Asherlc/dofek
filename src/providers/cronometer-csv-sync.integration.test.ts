import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { nutrientRowSchema } from "../db/nutrient-columns.ts";
import { foodEntry, foodEntryNutrient, TEST_USER_ID } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { CRONOMETER_PROVIDER_ID, importCronometerCsv } from "./cronometer-csv.ts";

// ============================================================
// Test CSV data — matches Cronometer Servings export format
// ============================================================

// Column order: Day, Meal, Food Name, Amount, Unit, Category,
// Energy, Protein, Carbs, Fat, Fiber,
// SatFat, PolyFat, MonoFat, TransFat,
// Cholesterol, Sodium, Potassium, Sugar,
// VitA, VitC, VitD, VitE, VitK,
// Thiamin, Riboflavin, Niacin, PantoAcid, B6,
// Biotin, Folate, B12,
// Calcium, Iron, Magnesium, Zinc, Selenium,
// Copper, Manganese, Chromium, Iodine,
// Omega3, Omega6, Water, Caffeine, Alcohol

const CSV_HEADER =
  "Day,Meal,Food Name,Amount,Unit,Category,Energy (kcal),Protein (g),Carbs (g),Fat (g),Fiber (g),Saturated (g),Polyunsaturated (g),Monounsaturated (g),Trans-Fats (g),Cholesterol (mg),Sodium (mg),Potassium (mg),Sugar (g),Vitamin A (mcg),Vitamin C (mg),Vitamin D (mcg),Vitamin E (mg),Vitamin K (mcg),Thiamin (mg),Riboflavin (mg),Niacin (mg),Pantothenic Acid (mg),Vitamin B6 (mg),Biotin (mcg),Folate (mcg),Vitamin B12 (mcg),Calcium (mg),Iron (mg),Magnesium (mg),Zinc (mg),Selenium (mcg),Copper (mg),Manganese (mg),Chromium (mcg),Iodine (mcg),Omega-3 (g),Omega-6 (g),Water (g),Caffeine (mg),Alcohol (g)";

const SIMPLE_CSV = `${CSV_HEADER}
2026-03-01,Breakfast,Oatmeal,1,cup,Cereals,150,5,27,3,4,0.5,1,0.8,0,0,2,130,1,0,0,0,0.2,1.5,0.1,0.1,0.7,0.3,0.1,3,15,0.2,100,1.5,40,1.2,8,0.1,0.8,0,0,0.01,0.5,200,95,0
2026-03-01,Breakfast,Banana,1,medium,Fruits,105,1.3,27,0.4,3.1,0.1,0.1,0,0,0,1,422,14,3,8.7,0,0.1,0.5,0,0,0.4,0.3,0.4,5,20,0.6,6,0.3,32,0.2,1,0.1,0.3,0,0,0.03,0.05,88,0,0
2026-03-01,Lunch,Chicken Breast,6,oz,Poultry,280,53,0,6,0,1.7,1.3,2.1,0,130,120,450,0,3,0,0.3,0.4,0,0.1,0.2,12.4,0.9,0.8,2,6,0.3,22,1.2,42,1.5,38,0.1,0,0,0,0,0.1,0,0`;

const MULTI_DAY_CSV = `${CSV_HEADER}
2026-03-01,Breakfast,Oatmeal,1,cup,Cereals,150,5,27,3,4,0.5,1,0.8,0,0,2,130,1,0,0,0,0.2,1.5,0.1,0.1,0.7,0.3,0.1,3,15,0.2,100,1.5,40,1.2,8,0.1,0.8,0,0,0.01,0.5,200,0,0
2026-03-02,Dinner,Salmon,5,oz,Fish,290,29,0,18,0,3.5,6.5,5.8,0,80,60,550,0,15,0,14.2,3.7,0,0.2,0.4,10.1,1.6,0.8,0.2,9,5.1,14,0.8,32,0.8,41,0.2,0,0,0,2.3,0.1,0,0,0`;

const SNACK_CSV = `${CSV_HEADER}
2026-03-03,Snack,Almonds,1,oz,Nuts,164,6,6,14,3.5,1.1,3.5,8.9,0,0,0,200,1,0,0,0,7.3,0,0,0.3,1,0.1,0,14,25,0,76,1.1,77,0.9,1.2,0.3,0.6,0,0,0,3.5,1.5,0,0`;

// Schema for querying v_food_entry_with_nutrition rows in tests
const viewRowSchema = z
  .object({
    food_name: z.string(),
    date: z.string(),
    meal: z.string().nullable(),
    number_of_units: z.coerce.number().nullable(),
    serving_unit: z.string().nullable(),
  })
  .merge(nutrientRowSchema);

const dailyNutritionRowSchema = z.object({
  date: z.string(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
});

/** Query the view for a specific food by name */
async function queryFoodFromView(db: TestContext["db"], foodName: string) {
  const rows = await db.execute<z.infer<typeof viewRowSchema>>(
    sql`SELECT * FROM fitness.v_food_entry_with_nutrition WHERE food_name = ${foodName} LIMIT 1`,
  );
  return rows[0] ?? null;
}

async function queryDailyNutritionFromView(db: TestContext["db"]) {
  return db.execute<z.infer<typeof dailyNutritionRowSchema>>(
    sql`
      SELECT date, calories, protein_g, carbs_g, fat_g
      FROM fitness.v_nutrition_daily
      WHERE provider_id = ${CRONOMETER_PROVIDER_ID}
    `,
  );
}

// ============================================================
// Tests
// ============================================================

describe("importCronometerCsv() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("imports food entries from CSV", async () => {
    const result = await importCronometerCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID);

    expect(result.provider).toBe(CRONOMETER_PROVIDER_ID);
    expect(result.recordsSynced).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Verify food_entry rows
    const rows = await ctx.db
      .select()
      .from(foodEntry)
      .where(eq(foodEntry.providerId, CRONOMETER_PROVIDER_ID));

    expect(rows).toHaveLength(3);

    // Query through the view to check nutrient data
    const oatmeal = await queryFoodFromView(ctx.db, "Oatmeal");
    if (!oatmeal) throw new Error("expected Oatmeal entry");
    expect(oatmeal.date).toBe("2026-03-01");
    expect(oatmeal.meal).toBe("breakfast");
    expect(oatmeal.calories).toBe(150);
    expect(oatmeal.protein_g).toBeCloseTo(5);
    expect(oatmeal.carbs_g).toBeCloseTo(27);
    expect(oatmeal.fat_g).toBeCloseTo(3);
    expect(oatmeal.fiber_g).toBeCloseTo(4);
    expect(oatmeal.number_of_units).toBe(1);
    expect(oatmeal.serving_unit).toBe("cup");

    const chicken = await queryFoodFromView(ctx.db, "Chicken Breast");
    if (!chicken) throw new Error("expected Chicken Breast entry");
    expect(chicken.meal).toBe("lunch");
    expect(chicken.calories).toBe(280);
    expect(chicken.protein_g).toBeCloseTo(53);
  });

  it("derives daily nutrition totals from food entries", async () => {
    const result = await importCronometerCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID);

    expect(result.errors).toHaveLength(0);

    const dailyRows = await queryDailyNutritionFromView(ctx.db);

    const march1 = dailyRows.find((r) => r.date === "2026-03-01");
    if (!march1) throw new Error("expected daily nutrition for 2026-03-01");

    // 150 + 105 + 280 = 535 calories
    expect(march1.calories).toBe(535);
    // 5 + 1.3 + 53 = 59.3 protein
    expect(march1.protein_g).toBeCloseTo(59.3);
    // 27 + 27 + 0 = 54 carbs
    expect(march1.carbs_g).toBeCloseTo(54);
    // 3 + 0.4 + 6 = 9.4 fat
    expect(march1.fat_g).toBeCloseTo(9.4);
  });

  it("derives separate daily nutrition rows for different days", async () => {
    const result = await importCronometerCsv(ctx.db, MULTI_DAY_CSV, TEST_USER_ID);

    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const dailyRows = await queryDailyNutritionFromView(ctx.db);

    const march1 = dailyRows.find((r) => r.date === "2026-03-01");
    const march2 = dailyRows.find((r) => r.date === "2026-03-02");
    expect(march1).toBeDefined();
    expect(march2).toBeDefined();
    expect(march2?.calories).toBe(290);
    expect(march2?.protein_g).toBeCloseTo(29);
  });

  it("maps snack meal type correctly", async () => {
    const result = await importCronometerCsv(ctx.db, SNACK_CSV, TEST_USER_ID);

    expect(result.recordsSynced).toBe(1);

    const rows = await ctx.db.select().from(foodEntry).where(eq(foodEntry.foodName, "Almonds"));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.meal).toBe("snack");
  });

  it("upserts food entries on re-import (no duplicates)", async () => {
    await importCronometerCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID);
    await importCronometerCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID);

    const rows = await ctx.db.select().from(foodEntry).where(eq(foodEntry.foodName, "Oatmeal"));

    // Should only have 1 Oatmeal entry (upserted, not duplicated)
    expect(rows).toHaveLength(1);
  });

  it("stores micronutrient data", async () => {
    await importCronometerCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID);

    const banana = await queryFoodFromView(ctx.db, "Banana");
    if (!banana) throw new Error("expected Banana entry");
    expect(banana.vitamin_c_mg).toBeCloseTo(8.7);
    expect(banana.potassium_mg).toBeCloseTo(422);
    expect(banana.magnesium_mg).toBeCloseTo(32);
  });

  it("stores caffeine in row-based food entry nutrients", async () => {
    await importCronometerCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID);

    const oatmealRows = await ctx.db
      .select()
      .from(foodEntry)
      .where(eq(foodEntry.foodName, "Oatmeal"));
    const oatmeal = oatmealRows[0];
    if (!oatmeal) throw new Error("expected Oatmeal entry");

    const rows = await ctx.db
      .select()
      .from(foodEntryNutrient)
      .where(eq(foodEntryNutrient.foodEntryId, oatmeal.id));
    const caffeine = rows.find((row) => row.nutrientId === "caffeine");

    expect(caffeine?.amount).toBeCloseTo(95);
  });

  it("converts omega fatty acids from grams to milligrams", async () => {
    await importCronometerCsv(ctx.db, MULTI_DAY_CSV, TEST_USER_ID);

    const salmon = await queryFoodFromView(ctx.db, "Salmon");
    if (!salmon) throw new Error("expected Salmon entry");
    // 2.3g omega-3 * 1000 = 2300 mg
    expect(salmon.omega3_mg).toBeCloseTo(2300, 0);
  });

  it("returns empty result for empty CSV", async () => {
    const result = await importCronometerCsv(ctx.db, CSV_HEADER, TEST_USER_ID);

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles BOM-prefixed CSV", async () => {
    const bomCsv = `\uFEFF${SNACK_CSV}`;
    const result = await importCronometerCsv(ctx.db, bomCsv, TEST_USER_ID);

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});
