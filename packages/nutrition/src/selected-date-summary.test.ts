import { describe, expect, it } from "vitest";
import {
  nutritionSourceResolutionSchema,
  selectedDateNutritionIntakeContextSchema,
  selectedDateNutritionSummarySchema,
} from "./selected-date-summary.ts";

const summary = {
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
};

describe("selectedDateNutritionSummarySchema", () => {
  it("parses the canonical selected-date display summary", () => {
    expect(selectedDateNutritionSummarySchema.parse(summary)).toEqual(summary);
  });

  it("rejects a goal progress percentage above the display maximum", () => {
    expect(() =>
      selectedDateNutritionSummarySchema.parse({
        ...summary,
        calorieGoal: { ...summary.calorieGoal, progressPercentage: 101 },
      }),
    ).toThrow();
  });

  it("rejects a macro energy share above 100 percent", () => {
    expect(() =>
      selectedDateNutritionSummarySchema.parse({
        ...summary,
        macros: {
          ...summary.macros,
          protein: { ...summary.macros.protein, energySharePercentage: 101 },
        },
      }),
    ).toThrow();
  });

  it("rejects a fractional macro energy share", () => {
    expect(() =>
      selectedDateNutritionSummarySchema.parse({
        ...summary,
        macros: {
          ...summary.macros,
          protein: { ...summary.macros.protein, energySharePercentage: 21.5 },
        },
      }),
    ).toThrow();
  });

  it("rejects non-zero macro energy shares that do not total 100 percent", () => {
    const result = selectedDateNutritionSummarySchema.safeParse({
      ...summary,
      macros: {
        ...summary.macros,
        protein: { ...summary.macros.protein, energySharePercentage: 21 },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual({
        code: "custom",
        message: "Macro energy shares must total 100 percent",
        path: ["macros"],
      });
    }
  });

  it("rejects zero shares when carbs and fat contain energy", () => {
    const zeroShare = { grams: 0, calories: 0, energySharePercentage: 0 };

    expect(() =>
      selectedDateNutritionSummarySchema.parse({
        ...summary,
        macros: {
          protein: zeroShare,
          carbs: { ...zeroShare, calories: 1 },
          fat: { ...zeroShare, calories: 1 },
        },
      }),
    ).toThrow();
  });

  it("accepts zero energy shares when all macro calories are zero", () => {
    const zeroMacro = { grams: 0, calories: 0, energySharePercentage: 0 };

    expect(
      selectedDateNutritionSummarySchema.parse({
        ...summary,
        macros: {
          protein: zeroMacro,
          carbs: zeroMacro,
          fat: zeroMacro,
        },
      }).macros,
    ).toEqual({
      protein: zeroMacro,
      carbs: zeroMacro,
      fat: zeroMacro,
    });
  });
});

describe("nutritionSourceResolutionSchema", () => {
  it("parses an explicit source conflict with server-owned provenance", () => {
    const resolution = {
      status: "source_conflict",
      message:
        "Totals are unavailable because nutrition sources overlap and no canonical contribution set can be determined.",
      sourceProviders: ["apple-health", "cronometer"],
      contributingProviders: [],
      excludedProviders: ["apple-health", "cronometer"],
      sourceLabels: ["Apple Health", "Cronometer"],
      contributingSourceLabels: [],
      excludedSourceLabels: ["Apple Health", "Cronometer"],
      contributionGrain: null,
      contributionLabel: null,
    };

    expect(nutritionSourceResolutionSchema.parse(resolution)).toEqual(resolution);
  });

  it("parses a server-authored daily aggregate label", () => {
    const resolution = {
      status: "available",
      message: "Totals use the only available nutrition source.",
      sourceProviders: ["apple_health"],
      contributingProviders: ["apple_health"],
      excludedProviders: [],
      sourceLabels: ["Cronometer (via Apple Health)"],
      contributingSourceLabels: ["Cronometer (via Apple Health)"],
      excludedSourceLabels: [],
      contributionGrain: "daily_aggregate",
      contributionLabel: "Cronometer (via Apple Health) daily total",
    };

    expect(nutritionSourceResolutionSchema.parse(resolution)).toEqual(resolution);
  });
});

describe("selectedDateNutritionIntakeContextSchema", () => {
  it("parses an uncapped, neutral intake comparison", () => {
    const context = {
      observedCalories: 4259,
      target: {
        calories: 2450,
        type: "configured",
        label: "Configured daily logged-intake target",
      },
      scale: {
        maximumCalories: 4259,
        observedPercentage: 100,
        targetPercentage: (2450 / 4259) * 100,
      },
      comparison: {
        status: "above_target",
        differenceCalories: 1809,
        message:
          "Observed logged intake is 1,809 kcal above the configured daily logged-intake target.",
      },
      limitation:
        "This target describes logged intake only; it is not an estimate of energy expenditure or calorie balance.",
    };

    expect(selectedDateNutritionIntakeContextSchema.parse(context)).toEqual(context);
  });
});
