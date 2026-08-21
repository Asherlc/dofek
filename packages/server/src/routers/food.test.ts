import { describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";
import type { FoodEntryRow } from "../repositories/food-repository.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/typed-sql.ts")>()),
  executeWithSchema: vi.fn(
    async (
      db: { execute: (query: unknown) => Promise<unknown[]> },
      _schema: unknown,
      query: unknown,
    ) => db.execute(query),
  ),
}));

import { foodRouter } from "./food.ts";

const createCaller = createTestCallerFactory(foodRouter);

const validFoodEntry = {
  id: "f1",
  provider_id: "dofek",
  user_id: "user-1",
  external_id: null,
  date: "2024-01-15",
  meal: "lunch",
  food_name: "Lunch",
  food_description: null,
  category: null,
  provider_food_id: null,
  provider_serving_id: null,
  number_of_units: null,
  logged_at: "2024-01-15T12:00:00.000Z",
  source_name: null,
  started_at: null,
  ended_at: null,
  barcode: null,
  serving_unit: null,
  serving_weight_grams: null,
  nutrition_data_id: null,
  raw: null,
  confirmed: true,
  created_at: "2024-01-15T12:00:00.000Z",
  calories: 0,
  protein_g: null,
  carbs_g: null,
  fat_g: null,
  saturated_fat_g: null,
  polyunsaturated_fat_g: null,
  monounsaturated_fat_g: null,
  trans_fat_g: null,
  cholesterol_mg: null,
  sodium_mg: null,
  potassium_mg: null,
  fiber_g: null,
  sugar_g: null,
  vitamin_a_mcg: null,
  vitamin_c_mg: null,
  vitamin_d_mcg: null,
  vitamin_e_mg: null,
  vitamin_k_mcg: null,
  vitamin_b1_mg: null,
  vitamin_b2_mg: null,
  vitamin_b3_mg: null,
  vitamin_b5_mg: null,
  vitamin_b6_mg: null,
  vitamin_b7_mcg: null,
  vitamin_b9_mcg: null,
  vitamin_b12_mcg: null,
  calcium_mg: null,
  iron_mg: null,
  magnesium_mg: null,
  zinc_mg: null,
  selenium_mcg: null,
  copper_mg: null,
  manganese_mg: null,
  chromium_mcg: null,
  iodine_mcg: null,
  omega3_mg: null,
  omega6_mg: null,
  caffeine_mg: null,
  water_ml: null,
} satisfies FoodEntryRow;

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
    timezone: "UTC",
  });
}

function makeConflictCaller() {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([validFoodEntry])
    .mockResolvedValueOnce([
      {
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        breakfast_calories: 0,
        lunch_calories: 0,
        dinner_calories: 0,
        snack_calories: 0,
        other_calories: 0,
        resolution_status: "source_conflict",
        resolution_message:
          "Totals are unavailable because nutrition sources overlap and no canonical contribution set can be determined.",
        source_providers: ["cronometer", "fatsecret"],
        contributing_providers: [],
        excluded_providers: ["cronometer", "fatsecret"],
        source_labels: ["cronometer", "fatsecret"],
        contributing_source_labels: [],
        excluded_source_labels: ["cronometer", "fatsecret"],
        contribution_grain: null,
        contribution_source_label: null,
      },
    ]);
  return createCaller({
    db: { execute },
    userId: "user-1",
    timezone: "UTC",
  });
}

describe("foodRouter", () => {
  describe("list", () => {
    it("returns food entries for date range", async () => {
      const rows = [{ id: "f1", food_name: "Chicken", calories: 300 }];
      const caller = makeCaller(rows);
      const result = await caller.list({
        startDate: "2024-01-01",
        endDate: "2024-01-31",
      });
      expect(result).toEqual(rows);
    });

    it("filters by meal when specified", async () => {
      const rows = [{ id: "f1", food_name: "Eggs", meal: "breakfast" }];
      const caller = makeCaller(rows);
      const result = await caller.list({
        startDate: "2024-01-01",
        endDate: "2024-01-31",
        meal: "breakfast",
      });
      expect(result).toEqual(rows);
    });
  });

  describe("byDate", () => {
    it("preserves the v1 available response contract", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ key: "calorieGoal", value: 1600 }])
        .mockResolvedValueOnce([{ id: "f1", food_name: "Lunch" }])
        .mockResolvedValueOnce([
          {
            calories: 1000,
            protein_g: 55,
            carbs_g: 105,
            fat_g: 40,
            breakfast_calories: 400,
            lunch_calories: 500,
            dinner_calories: 0,
            snack_calories: 0,
            other_calories: 100,
            resolution_status: "available",
            resolution_message:
              "Totals use the itemized source; overlapping daily aggregate sources are preserved but excluded.",
            source_providers: ["apple-health", "cronometer"],
            contributing_providers: ["cronometer"],
            excluded_providers: ["apple-health"],
            source_labels: ["apple-health", "cronometer"],
            contributing_source_labels: ["cronometer"],
            excluded_source_labels: ["apple-health"],
            contribution_grain: "itemized",
            contribution_source_label: "cronometer",
          },
        ]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.byDate({ date: "2024-01-15" });

      expect(result).toEqual({
        entries: [{ id: "f1", food_name: "Lunch" }],
        summary: {
          calories: 1000,
          mealCalories: {
            breakfast: 400,
            lunch: 500,
            dinner: 0,
            snack: 0,
            other: 100,
          },
          calorieGoal: {
            target: 1600,
            remaining: 600,
            over: 0,
            progressPercentage: 62.5,
          },
          macros: {
            protein: { grams: 55, calories: 220, energySharePercentage: 22 },
            carbs: { grams: 105, calories: 420, energySharePercentage: 42 },
            fat: { grams: 40, calories: 360, energySharePercentage: 36 },
          },
        },
      });
    });

    it("fails v1 conflicts with an actionable precondition error", async () => {
      const caller = makeConflictCaller();

      await expect(caller.byDate({ date: "2024-01-15" })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringContaining("keep one contribution set"),
      });
    });

    it("returns entries and explicit conflict metadata from v2", async () => {
      const caller = makeConflictCaller();

      const result = await caller.byDateV2({ date: "2024-01-15" });

      expect(result.summary).toBeNull();
      expect(result.resolution).toEqual(
        expect.objectContaining({
          status: "source_conflict",
          sourceProviders: ["cronometer", "fatsecret"],
          contributingProviders: [],
        }),
      );
    });

    it("returns a neutral uncapped intake context from v2", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ key: "calorieGoal", value: 2450 }])
        .mockResolvedValueOnce([
          { ...validFoodEntry, food_name: "Large logged meal", calories: 4259 },
        ])
        .mockResolvedValueOnce([
          {
            calories: 4259,
            protein_g: 100,
            carbs_g: 300,
            fat_g: 150,
            breakfast_calories: 1000,
            lunch_calories: 1200,
            dinner_calories: 1800,
            snack_calories: 259,
            other_calories: 0,
            resolution_status: "available",
            resolution_message: "Totals use the only available nutrition source.",
            source_providers: ["dofek"],
            contributing_providers: ["dofek"],
            excluded_providers: [],
            source_labels: ["Dofek"],
            contributing_source_labels: ["Dofek"],
            excluded_source_labels: [],
            contribution_grain: "itemized",
            contribution_source_label: "Dofek",
          },
        ]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.byDateV2({ date: "2024-01-15" });

      expect(result.intakeContext).toEqual({
        observedCalories: 4259,
        target: {
          calories: 2450,
          type: "configured",
          label: "Configured daily logged-intake target",
        },
        scale: {
          maximumCalories: 4259,
          observedPercentage: 100,
          targetPercentage: 57.525240666823194,
        },
        comparison: {
          status: "above_target",
          differenceCalories: 1809,
          message:
            "Observed logged intake is 1,809 kcal above the configured daily logged-intake target.",
        },
        limitation:
          "This target describes logged intake only; it is not an estimate of energy expenditure or calorie balance.",
      });
    });

    it("returns an at-target intake context from v2", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ key: "calorieGoal", value: 2450 }])
        .mockResolvedValueOnce([{ ...validFoodEntry, food_name: "Matched intake", calories: 2450 }])
        .mockResolvedValueOnce([
          {
            calories: 2450,
            protein_g: 100,
            carbs_g: 200,
            fat_g: 50,
            breakfast_calories: 2450,
            lunch_calories: 0,
            dinner_calories: 0,
            snack_calories: 0,
            other_calories: 0,
            resolution_status: "available",
            resolution_message: "Totals use the only available nutrition source.",
            source_providers: ["dofek"],
            contributing_providers: ["dofek"],
            excluded_providers: [],
            source_labels: ["Dofek"],
            contributing_source_labels: ["Dofek"],
            excluded_source_labels: [],
            contribution_grain: "itemized",
            contribution_source_label: "Dofek",
          },
        ]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.byDateV2({ date: "2024-01-15" });

      expect(result.intakeContext).toMatchObject({
        observedCalories: 2450,
        target: {
          calories: 2450,
        },
        scale: {
          maximumCalories: 2450,
          observedPercentage: 100,
          targetPercentage: 100,
        },
        comparison: {
          status: "at_target",
          differenceCalories: 0,
          message: "Observed logged intake matches the configured daily logged-intake target.",
        },
      });
    });

    it("logs when no rows are returned", async () => {
      const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
      const execute = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            calories: 0,
            protein_g: 0,
            carbs_g: 0,
            fat_g: 0,
            breakfast_calories: 0,
            lunch_calories: 0,
            dinner_calories: 0,
            snack_calories: 0,
            other_calories: 0,
            resolution_status: "available",
            resolution_message: "Totals use the only available nutrition source.",
            source_providers: [],
            contributing_providers: [],
            excluded_providers: [],
            source_labels: [],
            contributing_source_labels: [],
            excluded_source_labels: [],
            contribution_grain: null,
            contribution_source_label: null,
          },
        ]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.byDateV2({ date: "2024-01-15" });

      expect(infoSpy).toHaveBeenCalledWith(
        "[food] byDate returned 0 rows for userId=user-1 date=2024-01-15",
      );
      expect(result).toEqual(
        expect.objectContaining({
          summary: expect.objectContaining({ calories: 0 }),
          resolution: expect.objectContaining({ status: "available" }),
        }),
      );
    });

    it("does not log an aggregate-only day as an empty-data anomaly", async () => {
      const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
      const execute = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            calories: 1800,
            protein_g: 90,
            carbs_g: 220,
            fat_g: 60,
            breakfast_calories: 0,
            lunch_calories: 0,
            dinner_calories: 0,
            snack_calories: 0,
            other_calories: 1800,
            resolution_status: "available",
            resolution_message: "Totals use the only available nutrition source.",
            source_providers: ["apple-health"],
            contributing_providers: ["apple-health"],
            excluded_providers: [],
            source_labels: ["Apple Health"],
            contributing_source_labels: ["Apple Health"],
            excluded_source_labels: [],
            contribution_grain: "daily_aggregate",
            contribution_source_label: "Apple Health",
          },
        ]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.byDateV2({ date: "2024-01-15" });

      expect(infoSpy).not.toHaveBeenCalled();
      expect(result.resolution).toMatchObject({
        contributionGrain: "daily_aggregate",
        contributionLabel: "Apple Health daily total",
      });
    });
  });

  describe("dailyTotals", () => {
    it("returns aggregated daily totals", async () => {
      const rows = [
        {
          date: "2024-01-15",
          calories: 2100,
          protein_g: 150,
          carbs_g: 250,
          fat_g: 70,
          fiber_g: 30,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.dailyTotals({ days: 30 });
      expect(result).toEqual(rows);
    });
  });
});
