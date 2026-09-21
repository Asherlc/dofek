import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  fetchMicronutrientSafetyReviews,
  MicronutrientSafetyReview,
} from "./micronutrient-safety-review.ts";

function makeQuery(rows: Record<string, unknown>[] = []) {
  const normalizedRows = rows.map((row) => ({
    avg_provider_daily_total_intake: 0,
    source_breakdown: [],
    ...row,
  }));
  const execute = vi.fn().mockResolvedValue(normalizedRows);
  const run = () =>
    fetchMicronutrientSafetyReviews({
      db: { execute },
      userId: "user-1",
      days: 30,
      dateAccessPredicate: sql``,
    });
  return { execute, run };
}

describe("fetchMicronutrientSafetyReviews", () => {
  it("preserves meal aggregate provenance in its source breakdown", async () => {
    const { run } = makeQuery([
      {
        nutrient_id: "vitamin_c",
        nutrient: "Vitamin C",
        unit: "mg",
        avg_total_intake: 40,
        avg_food_intake: 40,
        avg_supplement_intake: 0,
        days_tracked: 1,
        source_breakdown: [
          {
            providerId: "ziva",
            sourceLabel: "Ziva",
            intakeType: "meal_aggregate",
            dailyAverageContribution: 40,
            daysTracked: 1,
          },
        ],
      },
    ]);

    const result = await run();

    expect(result[0]?.toDetail()).toMatchObject({
      intake: { foodDailyAverage: 40, providerDailyTotalAverage: 0 },
      sourceBreakdown: [{ intakeType: "meal_aggregate", dailyAverageContribution: 40 }],
    });
  });

  it("separates itemized food, provider daily totals, and supplements by source", async () => {
    const { run } = makeQuery([
      {
        nutrient_id: "vitamin_c",
        nutrient: "Vitamin C",
        unit: "mg",
        avg_total_intake: 90,
        avg_food_intake: 40,
        avg_supplement_intake: 50,
        days_tracked: 10,
        source_breakdown: [
          {
            providerId: "manual",
            sourceLabel: "manual",
            intakeType: "itemized_food",
            dailyAverageContribution: 40,
            daysTracked: 10,
          },
          {
            providerId: "dofek",
            sourceLabel: "dofek",
            intakeType: "supplement",
            dailyAverageContribution: 50,
            daysTracked: 5,
          },
        ],
      },
    ]);

    const result = await run();

    expect(result[0]?.toDetail()).toMatchObject({
      intake: {
        totalDailyAverage: 90,
        foodDailyAverage: 40,
        providerDailyTotalAverage: 0,
        supplementDailyAverage: 50,
        daysTracked: 10,
      },
      sourceBreakdown: [
        {
          providerId: "manual",
          sourceLabel: "manual",
          intakeType: "itemized_food",
          dailyAverageContribution: 40,
          daysTracked: 10,
        },
        {
          providerId: "dofek",
          sourceLabel: "dofek",
          intakeType: "supplement",
          dailyAverageContribution: 50,
          daysTracked: 5,
        },
      ],
    });
  });

  it("returns server-owned FDA adequacy and NIH upper-limit statuses", async () => {
    const { run } = makeQuery([
      {
        nutrient_id: "vitamin_d",
        nutrient: "Vitamin D",
        unit: "mcg",
        avg_total_intake: 120,
        avg_food_intake: 20,
        avg_supplement_intake: 100,
        days_tracked: 10,
      },
    ]);

    const result = await run();

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(MicronutrientSafetyReview);
    expect(result[0]?.toDetail()).toMatchObject({
      nutrientId: "vitamin_d",
      nutrient: "Vitamin D",
      intake: {
        totalDailyAverage: 120,
        foodDailyAverage: 20,
        supplementDailyAverage: 100,
        daysTracked: 10,
      },
      adequacy: {
        status: "at_or_above_daily_value",
        percentDailyValue: 600,
        reference: {
          type: "daily_value",
          amount: 20,
          population: "Adults and children age 4+",
        },
      },
      upperLimit: {
        status: "at_or_above_limit",
        amount: 100,
        intakeAmount: 120,
        intakeScope: "total",
        message:
          "Average intake over recorded days is at or above the included NIH adult upper limit. Review this intake with a doctor or pharmacist.",
      },
      safetyStatus: "at_or_above_upper_limit",
    });
  });

  it("does not present a generic below-Daily-Value result as a deficiency assessment", async () => {
    const { run } = makeQuery([
      {
        nutrient_id: "vitamin_c",
        nutrient: "Vitamin C",
        unit: "mg",
        avg_total_intake: 45,
        avg_food_intake: 45,
        avg_supplement_intake: 0,
        days_tracked: 5,
      },
    ]);

    const result = await run();

    expect(result[0]?.toDetail().adequacy).toMatchObject({
      status: "below_daily_value",
      message:
        "Average intake over recorded days is below the FDA Daily Value. This generic label reference is not a personalized deficiency assessment.",
    });
    expect(result[0]?.toDetail().intake.daysTracked).toBe(5);
  });

  it("classifies an intake exactly at the Daily Value as meeting the label reference", async () => {
    const { run } = makeQuery([
      {
        nutrient_id: "vitamin_c",
        nutrient: "Vitamin C",
        unit: "mg",
        avg_total_intake: 90,
        avg_food_intake: 90,
        avg_supplement_intake: 0,
        days_tracked: 1,
      },
    ]);

    const result = await run();

    expect(result[0]?.toDetail().adequacy).toMatchObject({
      status: "at_or_above_daily_value",
      percentDailyValue: 100,
      message:
        "Average intake over recorded days meets or exceeds the FDA Daily Value. This generic label reference is not a personalized safety assessment.",
    });
  });

  it("uses supplemental intake for a supplemental-only upper limit", async () => {
    const { run } = makeQuery([
      {
        nutrient_id: "magnesium",
        nutrient: "Magnesium",
        unit: "mg",
        avg_total_intake: 700,
        avg_food_intake: 400,
        avg_supplement_intake: 300,
        days_tracked: 7,
      },
    ]);

    const result = await run();

    expect(result[0]?.toDetail()).toMatchObject({
      upperLimit: {
        status: "within_limit",
        intakeAmount: 300,
        amount: 350,
        intakeScope: "supplemental_only",
        message:
          "Average intake over recorded days is below the included NIH adult upper limit. This does not rule out medication interactions or individual risks.",
      },
      safetyStatus: "within_upper_limit",
    });
  });

  it("compares the unrounded intake with an upper-limit boundary", async () => {
    const { run } = makeQuery([
      {
        nutrient_id: "zinc",
        nutrient: "Zinc",
        unit: "mg",
        avg_total_intake: 39.96,
        avg_food_intake: 19.96,
        avg_supplement_intake: 20,
        days_tracked: 7,
      },
    ]);

    const result = await run();

    expect(result[0]?.toDetail()).toMatchObject({
      intake: { totalDailyAverage: 40 },
      upperLimit: { status: "within_limit", intakeAmount: 39.96, amount: 40 },
      safetyStatus: "within_upper_limit",
    });
  });

  it("reports form-limited upper limits as not evaluable", async () => {
    const { run } = makeQuery([
      {
        nutrient_id: "vitamin_a",
        nutrient: "Vitamin A",
        unit: "mcg",
        avg_total_intake: 1_000,
        avg_food_intake: 800,
        avg_supplement_intake: 200,
        days_tracked: 3,
      },
    ]);

    const result = await run();

    expect(result[0]?.toDetail()).toMatchObject({
      adequacy: null,
      upperLimit: {
        status: "not_evaluable",
        limitation:
          "The NIH upper limit applies only to preformed vitamin A; tracked intake does not identify nutrient form.",
        message:
          "The NIH upper limit applies only to preformed vitamin A; tracked intake does not identify nutrient form.",
      },
      safetyStatus: "upper_limit_not_evaluable",
    });
  });

  it("reports incompatible tracked units instead of comparing mismatched values", async () => {
    const { run } = makeQuery([
      {
        nutrient_id: "vitamin_c",
        nutrient: "Vitamin C",
        unit: "g",
        avg_total_intake: 1,
        avg_food_intake: 1,
        avg_supplement_intake: 0,
        days_tracked: 2,
      },
    ]);

    const result = await run();

    expect(result[0]?.toDetail()).toMatchObject({
      adequacy: {
        status: "not_evaluable",
        limitation: "Tracked unit g does not match the FDA Daily Value unit mg.",
        message: "Tracked unit g does not match the FDA Daily Value unit mg.",
      },
      upperLimit: {
        status: "not_evaluable",
        limitation: "Tracked unit g does not match the sourced upper-limit unit mg.",
        message: "Tracked unit g does not match the sourced upper-limit unit mg.",
      },
      safetyStatus: "upper_limit_not_evaluable",
    });
  });

  it("keeps Daily Value nutrients without a bounded upper-limit rule", async () => {
    const { run } = makeQuery([
      {
        nutrient_id: "iron",
        nutrient: "Iron",
        unit: "mg",
        avg_total_intake: 10,
        avg_food_intake: 10,
        avg_supplement_intake: 0,
        days_tracked: 4,
      },
    ]);

    const result = await run();

    expect(result[0]?.toDetail()).toMatchObject({
      adequacy: { status: "below_daily_value" },
      upperLimit: {
        status: "not_in_ruleset",
        limitation: "No upper-limit rule is included in this bounded ruleset.",
        message: "No upper-limit rule is included in this bounded ruleset.",
      },
      safetyStatus: "no_upper_limit_in_ruleset",
    });
  });

  it("omits nutrients with neither a Daily Value nor a bounded upper-limit rule", async () => {
    const { run } = makeQuery([
      {
        nutrient_id: "unlisted_nutrient",
        nutrient: "Unlisted Nutrient",
        unit: "mg",
        avg_total_intake: 10,
        avg_food_intake: 10,
        avg_supplement_intake: 0,
        days_tracked: 4,
      },
    ]);

    await expect(run()).resolves.toEqual([]);
  });

  it("reads food and taken-supplement contributions separately", async () => {
    const { execute, run } = makeQuery([]);

    await run();

    const query = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(query).toContain("fitness.v_nutrition_canonical_nutrient");
    expect(query).toContain("fitness.v_nutrition_entry_classification");
    expect(query).toContain("itemized_food");
    expect(query).toContain("meal_aggregate");
    expect(query).toContain("provider_daily_total");
    expect(query).toContain("supplement_dose_event_id IS NOT NULL");
  });
});
