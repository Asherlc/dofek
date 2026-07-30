import { nutritionSourceResolutionSchema } from "@dofek/nutrition/selected-date-summary";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { BodyClickHouseStore } from "./body-clickhouse.ts";
import { FoodRepository } from "./food-repository.ts";
import { NutritionAnalyticsRepository } from "./nutrition-analytics-repository.ts";
import { ProviderDetailRepository } from "./provider-detail-repository.ts";

const OTHER_USER_ID = "00000000-0000-0000-0000-000000002059";
const resolutionStatusSchema = nutritionSourceResolutionSchema.shape.status;
const contributionGrainSchema = nutritionSourceResolutionSchema.shape.contributionGrain;
const idRowSchema = z.object({ id: z.string() });
const dailyNutritionRowSchema = z.object({
  calories: z.coerce.number(),
  protein_g: z.coerce.number(),
  resolution_status: resolutionStatusSchema,
  source_providers: z.array(z.string()),
  contributing_providers: z.array(z.string()),
  excluded_providers: z.array(z.string()),
});
const aggregateOnlyRowSchema = z.object({
  calories: z.coerce.number(),
  protein_g: z.coerce.number(),
  resolution_status: resolutionStatusSchema,
  contributing_source_labels: z.array(z.string()),
  contribution_grain: contributionGrainSchema,
});
const conflictRowSchema = z.object({
  calories: z.coerce.number().nullable(),
  resolution_status: resolutionStatusSchema,
  contributing_providers: z.array(z.string()),
});
const conflictSourceLabelsRowSchema = z.object({
  resolution_status: z.literal("source_conflict"),
  source_labels: z.array(z.string()),
  excluded_source_labels: z.array(z.string()),
});
const classificationRowSchema = z.object({
  provider_id: z.string(),
  effective_grain: z.string(),
});
const calorieResolutionRowSchema = z.object({
  calories: z.coerce.number(),
  resolution_status: z.string(),
});

describe("canonical nutrition contribution set", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name, email)
      VALUES (${OTHER_USER_ID}, 'Other nutrition user', 'nutrition-2059@example.com')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name)
      VALUES
        ('nutrition-itemized', 'Itemized Nutrition'),
        ('nutrition-aggregate', 'Aggregate Nutrition'),
        ('nutrition-other', 'Other Nutrition'),
        ('apple_health', 'Apple Health')
      ON CONFLICT (id) DO NOTHING
    `);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  async function addEntry(input: {
    userId?: string;
    providerId: string;
    date: string;
    grain?: "itemized" | "daily_aggregate" | null;
    foodName?: string | null;
    meal?: "breakfast" | "lunch" | "dinner" | "snack" | "other" | null;
    confirmed?: boolean;
    sourceName?: string | null;
    nutrients: Record<string, number>;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await context.db.execute(sql`
      INSERT INTO fitness.food_entry (
        id, user_id, provider_id, date, nutrition_grain, food_name, meal, source_name, confirmed
      )
      VALUES (
        ${id},
        ${input.userId ?? TEST_USER_ID},
        ${input.providerId},
        ${input.date}::date,
        ${input.grain ?? null}::fitness.nutrition_entry_grain,
        ${input.foodName ?? null},
        ${input.meal ?? null}::fitness.meal,
        ${input.sourceName ?? null},
        ${input.confirmed ?? true}
      )
    `);
    const nutrientRows = Object.entries(input.nutrients).map(
      ([nutrientId, amount]) => sql`(${id}::uuid, ${nutrientId}, ${amount}::real)`,
    );
    await context.db.execute(sql`
      INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
      VALUES ${sql.join(nutrientRows, sql`, `)}
    `);
    return id;
  }

  async function fetchAggregateRows(date: string) {
    return executeWithSchema(
      context.db,
      aggregateOnlyRowSchema,
      sql`
        SELECT calories, protein_g, resolution_status, contributing_source_labels, contribution_grain
        FROM fitness.v_nutrition_daily
        WHERE user_id = ${TEST_USER_ID} AND date = ${date}::date
      `,
    );
  }

  it("uses one itemized source and excludes an overlapping aggregate without deleting provenance", async () => {
    const date = "2026-01-01";
    const breakfastId = await addEntry({
      providerId: "nutrition-itemized",
      date,
      grain: "itemized",
      foodName: "Breakfast",
      meal: "breakfast",
      nutrients: { calories: 400, protein: 20, vitamin_c: 30 },
    });
    await addEntry({
      providerId: "nutrition-itemized",
      date,
      grain: "itemized",
      foodName: "Lunch",
      meal: "lunch",
      nutrients: { calories: 600, protein: 35, vitamin_c: 20 },
    });
    const aggregateId = await addEntry({
      providerId: "nutrition-aggregate",
      date,
      grain: "daily_aggregate",
      nutrients: { calories: 1800, protein: 100, vitamin_c: 90 },
    });
    await addEntry({
      providerId: "nutrition-other",
      date,
      grain: "daily_aggregate",
      nutrients: { calories: 1750, protein: 90, vitamin_c: 80 },
    });

    const dailyRows = await executeWithSchema(
      context.db,
      dailyNutritionRowSchema,
      sql`
      SELECT calories, protein_g, resolution_status, source_providers,
             contributing_providers, excluded_providers
      FROM fitness.v_nutrition_daily
      WHERE user_id = ${TEST_USER_ID} AND date = ${date}::date
    `,
    );

    expect(dailyRows).toEqual([
      expect.objectContaining({
        calories: 1000,
        protein_g: 55,
        resolution_status: "available",
        source_providers: ["nutrition-aggregate", "nutrition-itemized", "nutrition-other"],
        contributing_providers: ["nutrition-itemized"],
        excluded_providers: ["nutrition-aggregate", "nutrition-other"],
      }),
    ]);

    const canonicalEntries = await executeWithSchema(
      context.db,
      idRowSchema,
      sql`
      SELECT id
      FROM fitness.v_nutrition_display_entry
      WHERE user_id = ${TEST_USER_ID} AND date = ${date}::date
      ORDER BY id
    `,
    );
    expect(canonicalEntries.map((row) => row.id)).toContain(breakfastId);
    expect(canonicalEntries.map((row) => row.id)).not.toContain(aggregateId);

    const rawRows = await executeWithSchema(
      context.db,
      idRowSchema,
      sql`
      SELECT id
      FROM fitness.food_entry
      WHERE id = ${aggregateId}
    `,
    );
    expect(rawRows).toEqual([{ id: aggregateId }]);

    const providerRecord = await new ProviderDetailRepository(
      context.db,
      TEST_USER_ID,
    ).getRecordDetail("nutrition-aggregate", "foodEntries", aggregateId);
    expect(providerRecord).toEqual(
      expect.objectContaining({
        id: aggregateId,
        provider_id: "nutrition-aggregate",
        nutrition_grain: "daily_aggregate",
      }),
    );
  });

  it("uses an aggregate-only source exactly once", async () => {
    const date = "2026-01-02";
    await addEntry({
      providerId: "nutrition-aggregate",
      date,
      grain: "daily_aggregate",
      sourceName: "Imported total",
      nutrients: { calories: 1900 },
    });
    await addEntry({
      providerId: "nutrition-aggregate",
      date,
      grain: "daily_aggregate",
      sourceName: "Imported total",
      nutrients: { protein: 95 },
    });

    const rows = await fetchAggregateRows(date);
    expect(rows).toEqual([
      {
        calories: 1900,
        protein_g: 95,
        resolution_status: "available",
        contributing_source_labels: ["Imported total (via Aggregate Nutrition)"],
        contribution_grain: "daily_aggregate",
      },
    ]);
  });

  it("labels an Apple Health aggregate with its canonical provider source path", async () => {
    const date = "2026-01-09";
    await addEntry({
      providerId: "apple_health",
      date,
      grain: "daily_aggregate",
      sourceName: "Cronometer",
      nutrients: { calories: 1900, protein: 95 },
    });

    const rows = await fetchAggregateRows(date);

    expect(rows).toEqual([
      {
        calories: 1900,
        protein_g: 95,
        resolution_status: "available",
        contributing_source_labels: ["Cronometer (via Apple Health)"],
        contribution_grain: "daily_aggregate",
      },
    ]);
  });

  it.each([
    { date: "2026-01-10", sourceName: "Apple Health" },
    { date: "2026-01-11", sourceName: "   " },
  ])("collapses the Apple Health $sourceName subsource to its provider label", async ({
    date,
    sourceName,
  }) => {
    await addEntry({
      providerId: "apple_health",
      date,
      grain: "daily_aggregate",
      sourceName,
      nutrients: { calories: 1900, protein: 95 },
    });

    const rows = await fetchAggregateRows(date);

    expect(rows).toEqual([
      {
        calories: 1900,
        protein_g: 95,
        resolution_status: "available",
        contributing_source_labels: ["Apple Health"],
        contribution_grain: "daily_aggregate",
      },
    ]);
  });

  it("uses one direct-provider identity for provider-named and blank sources", async () => {
    const date = "2026-01-12";
    await addEntry({
      providerId: "nutrition-aggregate",
      date,
      grain: "daily_aggregate",
      sourceName: "aggregate nutrition",
      nutrients: { calories: 1900 },
    });
    await addEntry({
      providerId: "nutrition-aggregate",
      date,
      grain: "daily_aggregate",
      sourceName: "   ",
      nutrients: { protein: 95 },
    });

    const rows = await fetchAggregateRows(date);

    expect(rows).toEqual([
      {
        calories: 1900,
        protein_g: 95,
        resolution_status: "available",
        contributing_source_labels: ["Aggregate Nutrition"],
        contribution_grain: "daily_aggregate",
      },
    ]);
  });

  it("keeps distinct direct-provider import sources distinguishable", async () => {
    const date = "2026-01-16";
    await addEntry({
      providerId: "nutrition-aggregate",
      date,
      grain: "daily_aggregate",
      sourceName: "Import A",
      nutrients: { calories: 1900 },
    });
    await addEntry({
      providerId: "nutrition-aggregate",
      date,
      grain: "daily_aggregate",
      sourceName: "Import B",
      nutrients: { calories: 1850 },
    });

    const rows = await executeWithSchema(
      context.db,
      conflictSourceLabelsRowSchema,
      sql`
      SELECT resolution_status, source_labels, excluded_source_labels
      FROM fitness.v_nutrition_daily
      WHERE user_id = ${TEST_USER_ID} AND date = ${date}::date
    `,
    );

    expect(rows).toEqual([
      {
        resolution_status: "source_conflict",
        source_labels: ["Import A (via Aggregate Nutrition)", "Import B (via Aggregate Nutrition)"],
        excluded_source_labels: [
          "Import A (via Aggregate Nutrition)",
          "Import B (via Aggregate Nutrition)",
        ],
      },
    ]);
  });

  it("uses one Apple Health identity for provider-named and blank sources", async () => {
    const date = "2026-01-13";
    await addEntry({
      providerId: "apple_health",
      date,
      grain: "daily_aggregate",
      sourceName: "Apple Health",
      nutrients: { calories: 1900 },
    });
    await addEntry({
      providerId: "apple_health",
      date,
      grain: "daily_aggregate",
      sourceName: "   ",
      nutrients: { protein: 95 },
    });

    const rows = await fetchAggregateRows(date);

    expect(rows).toEqual([
      {
        calories: 1900,
        protein_g: 95,
        resolution_status: "available",
        contributing_source_labels: ["Apple Health"],
        contribution_grain: "daily_aggregate",
      },
    ]);
  });

  it("keeps a genuine Apple Health upstream app distinct from provider data", async () => {
    const date = "2026-01-14";
    await addEntry({
      providerId: "apple_health",
      date,
      grain: "daily_aggregate",
      sourceName: "Apple Health",
      nutrients: { calories: 1900 },
    });
    await addEntry({
      providerId: "apple_health",
      date,
      grain: "daily_aggregate",
      sourceName: "Cronometer",
      nutrients: { calories: 1850 },
    });

    const rows = await executeWithSchema(
      context.db,
      conflictSourceLabelsRowSchema,
      sql`
      SELECT resolution_status, source_labels, excluded_source_labels
      FROM fitness.v_nutrition_daily
      WHERE user_id = ${TEST_USER_ID} AND date = ${date}::date
    `,
    );

    expect(rows).toEqual([
      {
        resolution_status: "source_conflict",
        source_labels: ["Apple Health", "Cronometer (via Apple Health)"],
        excluded_source_labels: ["Apple Health", "Cronometer (via Apple Health)"],
      },
    ]);
  });

  it("rejects aggregate-only totals from multiple sources", async () => {
    const date = "2026-01-06";
    await addEntry({
      providerId: "nutrition-aggregate",
      date,
      grain: "daily_aggregate",
      nutrients: { calories: 1900 },
    });
    await addEntry({
      providerId: "nutrition-other",
      date,
      grain: "daily_aggregate",
      nutrients: { calories: 1850 },
    });

    const rows = await executeWithSchema(
      context.db,
      conflictRowSchema,
      sql`
      SELECT calories, resolution_status, contributing_providers
      FROM fitness.v_nutrition_daily
      WHERE user_id = ${TEST_USER_ID} AND date = ${date}::date
    `,
    );
    expect(rows).toEqual([
      {
        calories: null,
        resolution_status: "source_conflict",
        contributing_providers: [],
      },
    ]);
  });

  it("keeps one legacy ambiguous entry available exactly once", async () => {
    const date = "2026-01-07";
    await addEntry({
      providerId: "nutrition-aggregate",
      date,
      grain: null,
      nutrients: { calories: 1800, protein: 90 },
    });

    const rows = await fetchAggregateRows(date);
    expect(rows).toEqual([
      {
        calories: 1800,
        protein_g: 90,
        resolution_status: "available",
        contributing_source_labels: ["Aggregate Nutrition"],
        contribution_grain: "ambiguous",
      },
    ]);
  });

  it("marks genuinely ambiguous multi-source days unavailable", async () => {
    const date = "2026-01-03";
    await addEntry({
      providerId: "nutrition-itemized",
      date,
      grain: "itemized",
      foodName: "Named meal",
      meal: "dinner",
      nutrients: { calories: 700 },
    });
    await addEntry({
      providerId: "nutrition-other",
      date,
      grain: "itemized",
      foodName: "Other named meal",
      meal: "dinner",
      nutrients: { calories: 800 },
    });

    const rows = await executeWithSchema(
      context.db,
      conflictRowSchema,
      sql`
      SELECT calories, resolution_status, contributing_providers
      FROM fitness.v_nutrition_daily
      WHERE user_id = ${TEST_USER_ID} AND date = ${date}::date
    `,
    );
    expect(rows).toEqual([
      {
        calories: null,
        resolution_status: "source_conflict",
        contributing_providers: [],
      },
    ]);
  });

  it("classifies conservative legacy shapes and isolates date, user, and confirmation state", async () => {
    const date = "2026-01-04";
    await addEntry({
      providerId: "nutrition-itemized",
      date,
      grain: null,
      foodName: "Legacy named meal",
      nutrients: { calories: 500 },
    });
    await addEntry({
      providerId: "nutrition-aggregate",
      date,
      grain: null,
      nutrients: { calories: 1300 },
    });
    await addEntry({
      providerId: "nutrition-other",
      date: "2026-01-05",
      grain: "itemized",
      foodName: "Different day",
      nutrients: { calories: 900 },
    });
    await addEntry({
      userId: OTHER_USER_ID,
      providerId: "nutrition-other",
      date,
      grain: "itemized",
      foodName: "Different user",
      nutrients: { calories: 1100 },
    });
    await addEntry({
      providerId: "nutrition-itemized",
      date,
      grain: "itemized",
      foodName: "Draft",
      confirmed: false,
      nutrients: { calories: 1200 },
    });

    const classifications = await executeWithSchema(
      context.db,
      classificationRowSchema,
      sql`
      SELECT provider_id, effective_grain
      FROM fitness.v_nutrition_entry_classification
      WHERE user_id = ${TEST_USER_ID} AND date = ${date}::date AND confirmed = true
      ORDER BY provider_id
    `,
    );
    expect(classifications).toEqual([
      { provider_id: "nutrition-aggregate", effective_grain: "daily_aggregate" },
      { provider_id: "nutrition-itemized", effective_grain: "itemized" },
    ]);

    const rows = await executeWithSchema(
      context.db,
      calorieResolutionRowSchema,
      sql`
      SELECT calories, resolution_status
      FROM fitness.v_nutrition_daily
      WHERE user_id = ${TEST_USER_ID} AND date = ${date}::date
    `,
    );
    expect(rows).toEqual([{ calories: 500, resolution_status: "available" }]);

    const rangeTotals = await new FoodRepository(context.db, TEST_USER_ID, "UTC").dailyTotalsRange(
      date,
      date,
    );
    expect(rangeTotals[0]?.mealCount).toBe(1);
  });

  it("feeds micronutrient adequacy and adaptive TDEE from the same contribution set", async () => {
    const date = new Date().toISOString().slice(0, 10);
    await addEntry({
      providerId: "nutrition-itemized",
      date,
      grain: "itemized",
      foodName: "Current canonical meal",
      nutrients: { calories: 1000, vitamin_c: 50 },
    });
    await addEntry({
      providerId: "nutrition-aggregate",
      date,
      grain: "daily_aggregate",
      nutrients: { calories: 1800, vitamin_c: 100 },
    });

    const bodyStore: BodyClickHouseStore = {
      query: async () => [],
    };
    const repository = new NutritionAnalyticsRepository(
      context.db,
      TEST_USER_ID,
      "UTC",
      undefined,
      bodyStore,
    );

    const adequacy = await repository.getMicronutrientAdequacy(30);
    const vitaminC = adequacy.find((nutrient) => nutrient.nutrient === "Vitamin C");
    expect(vitaminC?.avgIntake).toBe(50);

    const tdeeData = await repository.getAdaptiveTdeeData(30, date);
    expect(tdeeData).toContainEqual({
      date,
      caloriesIn: 1000,
      nutritionStatus: "available",
      lowerPrioritySourcesExcluded: true,
      weightKg: null,
    });
  });
});
