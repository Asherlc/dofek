import { describe, expect, it } from "vitest";
import {
  foodEntryNutrientDetailsFromLegacyColumns,
  groupFoodEntryNutrientDetails,
} from "./food-entry-nutrition";

describe("foodEntryNutrientDetailsFromLegacyColumns", () => {
  it("returns display-ready nutrients from legacy snake_case food entry columns", () => {
    const details = foodEntryNutrientDetailsFromLegacyColumns({
      calories: 420,
      protein_g: 32,
      carbs_g: 41.5,
      sodium_mg: 680,
      vitamin_c_mg: null,
    });

    expect(details).toEqual([
      expect.objectContaining({
        id: "calories",
        label: "Calories",
        amount: 420,
        unit: "kcal",
        valueText: "420 kcal",
      }),
      expect.objectContaining({
        id: "protein",
        label: "Protein",
        amount: 32,
        unit: "g",
        valueText: "32 g",
      }),
      expect.objectContaining({
        id: "carbohydrate",
        label: "Carbohydrates",
        amount: 41.5,
        unit: "g",
        valueText: "41.5 g",
      }),
      expect.objectContaining({
        id: "sodium",
        label: "Sodium",
        amount: 680,
        unit: "mg",
        valueText: "680 mg",
      }),
    ]);
  });
});

describe("groupFoodEntryNutrientDetails", () => {
  it("groups nutrients under readable section labels", () => {
    const details = foodEntryNutrientDetailsFromLegacyColumns({
      protein_g: 32,
      sodium_mg: 680,
      vitamin_d_mcg: 10,
    });

    expect(groupFoodEntryNutrientDetails(details)).toEqual([
      {
        label: "Macros",
        nutrients: [expect.objectContaining({ id: "protein" })],
      },
      {
        label: "Other nutrients",
        nutrients: [expect.objectContaining({ id: "sodium" })],
      },
      {
        label: "Vitamins",
        nutrients: [expect.objectContaining({ id: "vitamin_d" })],
      },
    ]);
  });
});
