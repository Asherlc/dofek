import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  computeDailyTotals,
  computeMealCalories,
  type FoodEntry,
  foodEntrySchema,
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

describe("computeDailyTotals", () => {
  it("sums calories across entries", () => {
    const entries = [makeEntry({ calories: 200 }), makeEntry({ calories: 300 })];
    expect(computeDailyTotals(entries).totalCalories).toBe(500);
  });

  it("treats null calories as 0", () => {
    const entries = [makeEntry({ calories: null }), makeEntry({ calories: 300 })];
    expect(computeDailyTotals(entries).totalCalories).toBe(300);
  });

  it("treats all-null macros as 0", () => {
    const entries = [makeEntry({ calories: null, protein_g: null, carbs_g: null, fat_g: null })];
    const totals = computeDailyTotals(entries);
    expect(totals.totalCalories).toBe(0);
    expect(totals.totalProtein).toBe(0);
    expect(totals.totalCarbs).toBe(0);
    expect(totals.totalFat).toBe(0);
  });

  it("returns zeros for empty array", () => {
    const totals = computeDailyTotals([]);
    expect(totals.totalCalories).toBe(0);
    expect(totals.totalProtein).toBe(0);
    expect(totals.totalCarbs).toBe(0);
    expect(totals.totalFat).toBe(0);
  });
});

describe("computeMealCalories", () => {
  it("sums calories for a meal group", () => {
    const entries = [makeEntry({ calories: 100 }), makeEntry({ calories: 250 })];
    expect(computeMealCalories(entries)).toBe(350);
  });

  it("treats null calories as 0", () => {
    const entries = [makeEntry({ calories: null }), makeEntry({ calories: 150 })];
    expect(computeMealCalories(entries)).toBe(150);
  });

  it("returns 0 for empty array", () => {
    expect(computeMealCalories([])).toBe(0);
  });
});
