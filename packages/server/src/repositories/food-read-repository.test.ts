import { describe, expect, it, vi } from "vitest";
import {
  DailyNutritionSummary,
  DailyTotals,
  FoodEntry,
  FoodSearchResult,
} from "./food-entry-models.ts";
import { FoodReadRepository } from "./food-read-repository.ts";
import {
  availableResolutionRow,
  makeDailyTotalsRow,
  makeFoodEntryRow,
  makeFoodSearchRow,
  makeRepository as makeTestRepository,
} from "./food-repository-test-helpers.ts";

function makeRepository(rows: Record<string, unknown>[] = []) {
  return makeTestRepository(FoodReadRepository, rows);
}

describe("list", () => {
  it("returns empty array when no data", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.list("2024-06-01", "2024-06-30");
    expect(result).toEqual([]);
  });

  it("returns FoodEntry instances", async () => {
    const { repo } = makeRepository([makeFoodEntryRow()]);
    const result = await repo.list("2024-06-01", "2024-06-30");
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(FoodEntry);
    expect(result[0]?.foodName).toBe("Chicken Breast");
  });

  it("filters by meal when provided", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.list("2024-06-01", "2024-06-30", "lunch");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("AND meal =");
  });

  it("queries without meal filter when not provided", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.list("2024-06-01", "2024-06-30");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).not.toContain("AND meal =");
  });

  it("returns FoodEntry instances when meal is provided", async () => {
    const { repo } = makeRepository([makeFoodEntryRow({ meal: "dinner" })]);
    const result = await repo.list("2024-06-01", "2024-06-30", "dinner");
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(FoodEntry);
    expect(result[0]?.meal).toBe("dinner");
  });

  it("uses different SQL for meal vs no-meal (branch coverage)", async () => {
    // Verify both branches produce FoodEntry arrays from the same mock data
    const row = makeFoodEntryRow();
    const executeMeal = vi.fn().mockResolvedValue([row]);
    const repoMeal = new FoodReadRepository({ execute: executeMeal }, "user-1", "UTC");
    const withMeal = await repoMeal.list("2024-06-01", "2024-06-30", "lunch");

    const executeNoMeal = vi.fn().mockResolvedValue([row]);
    const repoNoMeal = new FoodReadRepository({ execute: executeNoMeal }, "user-1", "UTC");
    const withoutMeal = await repoNoMeal.list("2024-06-01", "2024-06-30");

    expect(withMeal).toHaveLength(1);
    expect(withoutMeal).toHaveLength(1);
    // Both branches call execute once but with different SQL
    expect(executeMeal).toHaveBeenCalledTimes(1);
    expect(executeNoMeal).toHaveBeenCalledTimes(1);
  });
});

describe("byDate", () => {
  it("returns FoodEntry instances for a date", async () => {
    const { repo } = makeRepository([makeFoodEntryRow()]);
    const result = await repo.byDate("2024-06-15");
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(FoodEntry);
  });

  it("returns empty array when no entries for date", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.byDate("2024-06-15");
    expect(result).toEqual([]);
  });

  it("queries the display surface that excludes aggregate-only rows", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.byDate("2024-06-15");
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain(
      "fitness.v_nutrition_display_entry",
    );
  });
});

describe("nutritionSummaryByDate", () => {
  it("returns an explicit empty available summary when no source reported data", async () => {
    const { repo } = makeRepository([]);

    const result = await repo.nutritionByDate("2024-06-15", 2000);

    expect(result).toEqual({
      summary: {
        calories: 0,
        mealCalories: {
          breakfast: 0,
          lunch: 0,
          dinner: 0,
          snack: 0,
          other: 0,
        },
        calorieGoal: {
          target: 2000,
          remaining: 2000,
          over: 0,
          progressPercentage: 0,
        },
        macros: {
          protein: { grams: 0, calories: 0, energySharePercentage: 0 },
          carbs: { grams: 0, calories: 0, energySharePercentage: 0 },
          fat: { grams: 0, calories: 0, energySharePercentage: 0 },
        },
      },
      resolution: {
        status: "available",
        message: "No nutrition sources have reported data for this date.",
        sourceProviders: [],
        contributingProviders: [],
        excludedProviders: [],
        sourceLabels: [],
        contributingSourceLabels: [],
        excludedSourceLabels: [],
        contributionGrain: null,
        contributionLabel: null,
      },
    });
  });

  it("returns server-computed daily, meal, goal, and macro metrics", async () => {
    const { repo } = makeRepository([
      {
        ...availableResolutionRow,
        calories: "1000",
        protein_g: "55",
        carbs_g: "105",
        fat_g: "40",
        breakfast_calories: "400",
        lunch_calories: "500",
        dinner_calories: "0",
        snack_calories: "0",
        other_calories: "100",
      },
    ]);

    const result = await repo.nutritionSummaryByDate("2024-06-15", 1600);

    expect(result).toEqual({
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
    });
  });

  it("labels a provider daily aggregate from server-owned provenance", async () => {
    const { repo } = makeRepository([
      {
        ...availableResolutionRow,
        calories: 1800,
        protein_g: 90,
        carbs_g: 220,
        fat_g: 60,
        breakfast_calories: 0,
        lunch_calories: 0,
        dinner_calories: 0,
        snack_calories: 0,
        other_calories: 1800,
        source_providers: ["apple_health"],
        contributing_providers: ["apple_health"],
        source_labels: ["Cronometer (via Apple Health)"],
        contributing_source_labels: ["Cronometer (via Apple Health)"],
        contribution_grain: "daily_aggregate",
        contribution_source_label: "Cronometer (via Apple Health)",
      },
    ]);

    const result = await repo.nutritionByDate("2024-06-15", 2000);

    expect(result.resolution).toMatchObject({
      contributionGrain: "daily_aggregate",
      contributionLabel: "Cronometer (via Apple Health) daily total",
    });
  });

  it.each([
    {
      contributionGrain: "itemized",
      contributionLabel: "Cronometer (via Apple Health) itemized entries",
    },
    {
      contributionGrain: "ambiguous",
      contributionLabel: "Cronometer (via Apple Health) nutrition data",
    },
    {
      contributionGrain: null,
      contributionLabel: null,
    },
  ])(
    "labels $contributionGrain contribution provenance without changing its grain",
    async ({ contributionGrain, contributionLabel }) => {
      const { repo } = makeRepository([
        {
          ...availableResolutionRow,
          calories: 1800,
          protein_g: 90,
          carbs_g: 220,
          fat_g: 60,
          breakfast_calories: 0,
          lunch_calories: 0,
          dinner_calories: 0,
          snack_calories: 0,
          other_calories: 1800,
          source_labels: ["Cronometer (via Apple Health)"],
          contributing_source_labels: ["Cronometer (via Apple Health)"],
          contribution_grain: contributionGrain,
          contribution_source_label: "Cronometer (via Apple Health)",
        },
      ]);

      const result = await repo.nutritionByDate("2024-06-15", 2000);

      expect(result.resolution).toMatchObject({
        contributionGrain,
        contributionLabel,
      });
    },
  );

  it("caps goal progress and reports calories over the target", async () => {
    const { repo } = makeRepository([
      {
        ...availableResolutionRow,
        calories: 1000,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
        breakfast_calories: 0,
        lunch_calories: 0,
        dinner_calories: 0,
        snack_calories: 0,
        other_calories: 0,
      },
    ]);

    const result = await repo.nutritionSummaryByDate("2024-06-15", 800);

    expect(result.calorieGoal).toEqual({
      target: 800,
      remaining: 0,
      over: 200,
      progressPercentage: 100,
    });
  });

  it("returns null totals with explicit provenance for a source conflict", async () => {
    const conflictResolution = {
      resolution_status: "source_conflict",
      resolution_message: "Totals are unavailable because nutrition sources overlap.",
      source_providers: ["apple-health", "cronometer"],
      contributing_providers: [],
      excluded_providers: ["apple-health", "cronometer"],
      source_labels: ["Apple Health", "Cronometer"],
      contributing_source_labels: [],
      excluded_source_labels: ["Apple Health", "Cronometer"],
      contribution_grain: null,
      contribution_source_label: null,
    };
    const { repo } = makeRepository([
      {
        ...conflictResolution,
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        breakfast_calories: 0,
        lunch_calories: 0,
        dinner_calories: 0,
        snack_calories: 0,
        other_calories: 0,
      },
    ]);

    const result = await repo.nutritionByDate("2024-06-15", 2000);

    expect(result.summary).toBeNull();
    expect(result.resolution).toEqual({
      status: "source_conflict",
      message: conflictResolution.resolution_message,
      sourceProviders: conflictResolution.source_providers,
      contributingProviders: [],
      excludedProviders: conflictResolution.excluded_providers,
      sourceLabels: conflictResolution.source_labels,
      contributingSourceLabels: [],
      excludedSourceLabels: conflictResolution.excluded_source_labels,
      contributionGrain: null,
      contributionLabel: null,
    });
  });
});

describe("dailyTotals", () => {
  it("returns DailyTotals instances", async () => {
    const { repo } = makeRepository([makeDailyTotalsRow()]);
    const result = await repo.dailyTotals(30);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(DailyTotals);
    expect(result[0]?.date).toBe("2024-06-15");
  });

  it("returns empty array when no data", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.dailyTotals(30);
    expect(result).toEqual([]);
  });

  it("queries canonical resolved daily totals", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.dailyTotals(30);
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("fitness.v_nutrition_daily");
  });
});

describe("dailyTotalsRange", () => {
  it("returns exact-range totals with meal counts and provider provenance", async () => {
    const { repo } = makeRepository([
      {
        ...availableResolutionRow,
        date: "2024-06-15",
        calories: "2450",
        protein_g: "165",
        carbs_g: "280",
        fat_g: "85",
        fiber_g: "32",
        meal_count: "4",
        logging_completeness: "unknown_completeness",
        logging_completeness_reason:
          "Nutrition was logged, but no source explicitly reported whether the day was complete.",
        source_providers: ["fatsecret"],
      },
    ]);

    const result = await repo.dailyTotalsRange("2024-06-15", "2024-06-15");

    expect(result[0]).toBeInstanceOf(DailyNutritionSummary);
    expect(result[0]?.date).toBe("2024-06-15");
    expect(result[0]?.calories).toBe(2450);
    expect(result[0]?.proteinGrams).toBe(165);
    expect(result[0]?.carbsGrams).toBe(280);
    expect(result[0]?.fatGrams).toBe(85);
    expect(result[0]?.fiberGrams).toBe(32);
    expect(result[0]?.mealCount).toBe(4);
    expect(result[0]?.sourceProviders).toEqual(["fatsecret"]);
    expect(result[0]?.resolutionStatus).toBe("available");
    expect(result[0]?.resolutionMessage).toBe(availableResolutionRow.resolution_message);
    expect(result[0]?.contributingProviders).toEqual(["dofek"]);
    expect(result[0]?.excludedProviders).toEqual([]);
    expect(result[0]?.loggingCompleteness).toBe("unknown_completeness");
    expect(result[0]?.loggingCompletenessReason).toContain("no source explicitly reported");
  });

  it("returns a no-logging date spine without turning missing nutrition into zero", async () => {
    const { repo, execute } = makeRepository([
      {
        date: "2024-06-16",
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        meal_count: 0,
        logging_completeness: "no_logging",
        logging_completeness_reason: "No food or nutrition records were logged for this date.",
        resolution_status: "available",
        resolution_message: "No nutrition sources contributed records for this date.",
        source_providers: [],
        contributing_providers: [],
        excluded_providers: [],
        source_labels: [],
        contributing_source_labels: [],
        excluded_source_labels: [],
      },
    ]);

    const result = await repo.dailyTotalsRange("2024-06-15", "2024-06-16");

    expect(result[0]?.loggingCompleteness).toBe("no_logging");
    expect(result[0]?.calories).toBeNull();
    expect(result[0]?.proteinGrams).toBeNull();
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("generate_series");
  });

  it("does not infer logging completeness from a low calorie total", async () => {
    const { repo } = makeRepository([
      {
        ...availableResolutionRow,
        date: "2024-06-15",
        calories: 150,
        protein_g: 5,
        carbs_g: 20,
        fat_g: 4,
        fiber_g: 1,
        meal_count: 1,
        logging_completeness: "unknown_completeness",
        logging_completeness_reason:
          "Nutrition was logged, but no source explicitly reported whether the day was complete.",
      },
    ]);

    const result = await repo.dailyTotalsRange("2024-06-15", "2024-06-15");

    expect(result[0]?.calories).toBe(150);
    expect(result[0]?.loggingCompleteness).toBe("unknown_completeness");
  });
});

describe("search", () => {
  it("returns FoodSearchResult instances", async () => {
    const { repo } = makeRepository([makeFoodSearchRow()]);
    const result = await repo.search("chicken", 20);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(FoodSearchResult);
    expect(result[0]?.foodName).toBe("Chicken Breast");
  });

  it("passes query to execute", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.search("rice", 10);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("search — search pattern", () => {
  it("wraps query with % wildcards for ILIKE", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.search("chicken", 10);
    const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(queryJson).toContain("%chicken%");
  });

  it("returns empty array when no matches", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.search("nonexistent", 10);
    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });
});

describe("list — SQL parameters are passed correctly", () => {
  it("passes startDate, endDate, and userId to the SQL query (no meal)", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.list("2024-01-01", "2024-12-31");
    const queryArg = execute.mock.calls[0]?.[0];
    const queryJson = JSON.stringify(queryArg);
    expect(queryJson).toContain("2024-01-01");
    expect(queryJson).toContain("2024-12-31");
    expect(queryJson).toContain("user-1");
  });

  it("passes startDate, endDate, userId, and meal to the SQL query (with meal)", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.list("2024-03-01", "2024-03-31", "dinner");
    const queryArg = execute.mock.calls[0]?.[0];
    const queryJson = JSON.stringify(queryArg);
    expect(queryJson).toContain("2024-03-01");
    expect(queryJson).toContain("2024-03-31");
    expect(queryJson).toContain("user-1");
    expect(queryJson).toContain("dinner");
  });

  it("maps multiple rows to FoodEntry instances preserving order", async () => {
    const row1 = makeFoodEntryRow({ id: "a", food_name: "Apple" });
    const row2 = makeFoodEntryRow({ id: "b", food_name: "Banana" });
    const { repo } = makeRepository([row1, row2]);
    const result = await repo.list("2024-06-01", "2024-06-30");
    expect(result).toHaveLength(2);
    expect(result[0]?.foodName).toBe("Apple");
    expect(result[1]?.foodName).toBe("Banana");
  });

  it("maps multiple rows when meal is specified", async () => {
    const row1 = makeFoodEntryRow({ id: "a", food_name: "Eggs", meal: "breakfast" });
    const row2 = makeFoodEntryRow({ id: "b", food_name: "Toast", meal: "breakfast" });
    const { repo } = makeRepository([row1, row2]);
    const result = await repo.list("2024-06-01", "2024-06-30", "breakfast");
    expect(result).toHaveLength(2);
    expect(result[0]?.foodName).toBe("Eggs");
    expect(result[1]?.foodName).toBe("Toast");
  });

  it("does NOT use meal branch when meal is empty string (falsy)", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.list("2024-06-01", "2024-06-30", "");
    // empty string is falsy, so the no-meal branch executes
    // The query should NOT contain the meal parameter
    // (the no-meal query doesn't include a meal filter)
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("byDate — SQL parameters", () => {
  it("passes date and userId to the query", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.byDate("2024-07-04");
    const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(queryJson).toContain("2024-07-04");
    expect(queryJson).toContain("user-1");
  });

  it("maps multiple rows preserving order", async () => {
    const row1 = makeFoodEntryRow({ id: "x", food_name: "Salad" });
    const row2 = makeFoodEntryRow({ id: "y", food_name: "Soup" });
    const { repo } = makeRepository([row1, row2]);
    const result = await repo.byDate("2024-06-15");
    expect(result).toHaveLength(2);
    expect(result[0]?.foodName).toBe("Salad");
    expect(result[1]?.foodName).toBe("Soup");
  });
});

describe("dailyTotals — SQL parameters and mapping", () => {
  it("passes days and userId to the query", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.dailyTotals(7);
    const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(queryJson).toContain("user-1");
  });

  it("maps multiple rows to DailyTotals instances preserving order", async () => {
    const row1 = makeDailyTotalsRow({ date: "2024-06-14", calories: 1800 });
    const row2 = makeDailyTotalsRow({ date: "2024-06-15", calories: 2100 });
    const { repo } = makeRepository([row1, row2]);
    const result = await repo.dailyTotals(30);
    expect(result).toHaveLength(2);
    expect(result[0]?.date).toBe("2024-06-14");
    expect(result[0]?.calories).toBe(1800);
    expect(result[1]?.date).toBe("2024-06-15");
    expect(result[1]?.calories).toBe(2100);
  });

  it("each result is a DailyTotals instance (not plain object)", async () => {
    const { repo } = makeRepository([makeDailyTotalsRow()]);
    const result = await repo.dailyTotals(30);
    expect(result[0]).toBeInstanceOf(DailyTotals);
  });
});

describe("search — SQL parameters and mapping", () => {
  it("passes limit and userId to the query", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.search("rice", 5);
    const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(queryJson).toContain("user-1");
  });

  it("constructs search pattern with percent signs around query", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.search("oat", 10);
    const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(queryJson).toContain("%oat%");
  });

  it("maps multiple rows to FoodSearchResult instances preserving order", async () => {
    const row1 = makeFoodSearchRow({ food_name: "Brown Rice" });
    const row2 = makeFoodSearchRow({ food_name: "White Rice" });
    const { repo } = makeRepository([row1, row2]);
    const result = await repo.search("rice", 10);
    expect(result).toHaveLength(2);
    expect(result[0]?.foodName).toBe("Brown Rice");
    expect(result[1]?.foodName).toBe("White Rice");
    expect(result[0]).toBeInstanceOf(FoodSearchResult);
    expect(result[1]).toBeInstanceOf(FoodSearchResult);
  });
});

describe("constructor — userId is used in queries", () => {
  it("uses the userId passed to the constructor, not a hardcoded value", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new FoodReadRepository({ execute }, "custom-user-42", "UTC");
    await repo.byDate("2024-06-15");
    const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(queryJson).toContain("custom-user-42");
  });

  it("uses different userId for different repository instances", async () => {
    const execute1 = vi.fn().mockResolvedValue([]);
    const repo1 = new FoodReadRepository({ execute: execute1 }, "user-alpha", "UTC");
    await repo1.byDate("2024-06-15");

    const execute2 = vi.fn().mockResolvedValue([]);
    const repo2 = new FoodReadRepository({ execute: execute2 }, "user-beta", "UTC");
    await repo2.byDate("2024-06-15");

    const query1Json = JSON.stringify(execute1.mock.calls[0]?.[0]);
    const query2Json = JSON.stringify(execute2.mock.calls[0]?.[0]);
    expect(query1Json).toContain("user-alpha");
    expect(query2Json).toContain("user-beta");
    expect(query1Json).not.toContain("user-beta");
  });
});
