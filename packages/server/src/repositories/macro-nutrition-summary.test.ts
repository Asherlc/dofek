import { describe, expect, it } from "vitest";
import { summarizeMacros } from "./macro-nutrition-summary.ts";

describe("summarizeMacros", () => {
  it("normalizes macro energy and deterministically rounds the shares to 100 percent", () => {
    const result = summarizeMacros(65, 107.5, 340 / 9);

    expect(result).toEqual({
      protein: { grams: 65, calories: 260, energySharePercentage: 25 },
      carbs: { grams: 107.5, calories: 430, energySharePercentage: 42 },
      fat: {
        grams: 340 / 9,
        calories: 340,
        energySharePercentage: 33,
      },
    });
    expect(
      result.protein.energySharePercentage +
        result.carbs.energySharePercentage +
        result.fat.energySharePercentage,
    ).toBe(100);
  });

  it("uses protein, carbs, then fat as the stable equal-remainder tie order", () => {
    expect(summarizeMacros(1, 1, 4 / 9)).toEqual({
      protein: { grams: 1, calories: 4, energySharePercentage: 34 },
      carbs: { grams: 1, calories: 4, energySharePercentage: 33 },
      fat: { grams: 4 / 9, calories: 4, energySharePercentage: 33 },
    });
  });

  it("returns zero shares when all macro energy is zero", () => {
    expect(summarizeMacros(0, 0, 0)).toEqual({
      protein: { grams: 0, calories: 0, energySharePercentage: 0 },
      carbs: { grams: 0, calories: 0, energySharePercentage: 0 },
      fat: { grams: 0, calories: 0, energySharePercentage: 0 },
    });
  });
});
