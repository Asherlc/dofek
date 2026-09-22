import { describe, expect, it } from "vitest";
import {
  nutritionSourceResolution,
  selectedDateNutritionTotalsRowSchema,
} from "./nutrition-source-resolution.ts";

describe("nutritionSourceResolution", () => {
  it("labels meal totals from server-owned provenance", () => {
    const row = selectedDateNutritionTotalsRowSchema.parse({
      calories: 500,
      protein_g: 30,
      carbs_g: 50,
      fat_g: 20,
      breakfast_calories: 0,
      lunch_calories: 500,
      dinner_calories: 0,
      snack_calories: 0,
      other_calories: 0,
      resolution_status: "available",
      resolution_message: "Totals use the only available nutrition source.",
      source_providers: ["ziva"],
      contributing_providers: ["ziva"],
      excluded_providers: [],
      source_labels: ["Ziva"],
      contributing_source_labels: ["Ziva"],
      excluded_source_labels: [],
      contribution_grain: "meal_aggregate",
      contribution_source_label: "Ziva",
    });

    expect(nutritionSourceResolution(row)).toMatchObject({
      contributionGrain: "meal_aggregate",
      contributionLabel: "Ziva meal totals",
    });
  });
});
