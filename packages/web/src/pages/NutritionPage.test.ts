import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type FoodEntry,
  foodEntrySchema,
  selectedDateFoodSchema,
  selectedDateFoodV2Schema,
} from "./NutritionPage";

const entrySchema = z.array(foodEntrySchema);

function makeEntry(overrides: Partial<FoodEntry> = {}): FoodEntry {
  return {
    id: "1",
    food_name: "Test Food",
    meal: "breakfast",
    calories: 200,
    protein_g: 10,
    carbs_g: 30,
    fat_g: 8,
    food_description: null,
    ...overrides,
  };
}

describe("foodEntrySchema", () => {
  it("parses entries with numeric calories", () => {
    const input = [makeEntry({ calories: 250 })];
    const [first] = entrySchema.parse(input);
    expect(first?.calories).toBe(250);
  });

  it("preserves detailed nutrient fields returned by food.byDate", () => {
    const input = [{ ...makeEntry(), sodium_mg: 680 }];
    const [first] = entrySchema.parse(input);
    expect(first?.sodium_mg).toBe(680);
  });

  it("parses entries with null calories", () => {
    const input = [makeEntry({ calories: null })];
    const [first] = entrySchema.parse(input);
    expect(first?.calories).toBeNull();
  });

  it("rejects entries with undefined calories", () => {
    const input = [{ ...makeEntry(), calories: undefined }];
    expect(() => entrySchema.parse(input)).toThrow();
  });

  it("rejects entries with string calories", () => {
    const input = [{ ...makeEntry(), calories: "200" }];
    expect(() => entrySchema.parse(input)).toThrow();
  });
});

describe("selectedDateFoodSchema", () => {
  it("parses the v1 response with a non-null server-owned display summary", () => {
    const result = selectedDateFoodSchema.parse({
      entries: [makeEntry()],
      summary: {
        calories: 999,
        mealCalories: { breakfast: 777, lunch: 0, dinner: 0, snack: 0, other: 0 },
        calorieGoal: { target: 2200, remaining: 1201, over: 0, progressPercentage: 45.4 },
        macros: {
          protein: { grams: 88, calories: 352, percentage: 35 },
          carbs: { grams: 111, calories: 444, percentage: 44 },
          fat: { grams: 22, calories: 198, percentage: 20 },
        },
      },
    });

    expect(result.summary.calories).toBe(999);
    expect(result.summary.mealCalories.breakfast).toBe(777);
  });
});

describe("selectedDateFoodV2Schema", () => {
  it("parses conflict metadata with no mixed-source summary", () => {
    const result = selectedDateFoodV2Schema.parse({
      entries: [makeEntry()],
      summary: null,
      resolution: {
        status: "source_conflict",
        message: "Totals are unavailable because nutrition sources overlap.",
        sourceProviders: ["cronometer", "fatsecret"],
        contributingProviders: [],
        excludedProviders: ["cronometer", "fatsecret"],
        sourceLabels: ["Cronometer", "FatSecret"],
        contributingSourceLabels: [],
        excludedSourceLabels: ["Cronometer", "FatSecret"],
      },
    });

    expect(result.summary).toBeNull();
    expect(result.resolution.status).toBe("source_conflict");
  });
});
