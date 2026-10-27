/** @vitest-environment jsdom */

import type { DayNutritionPreview } from "@dofek/mcp-contracts/day-nutrition";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DayNutritionPreviewPanel } from "./day-nutrition-preview.tsx";

const preview: DayNutritionPreview = {
  date: "2026-09-07",
  total_calories: 1450,
  protein_g: 98,
  carbs_g: 120,
  fat_g: 55,
  meals: [
    { meal: "breakfast", calories: 400, share_percentage: (400 / 1450) * 100 },
    { meal: "lunch", calories: 500, share_percentage: (500 / 1450) * 100 },
    { meal: "dinner", calories: 450, share_percentage: (450 / 1450) * 100 },
    { meal: "snack", calories: 100, share_percentage: (100 / 1450) * 100 },
    { meal: "other", calories: 0, share_percentage: 0 },
  ],
  macros: {
    protein: { grams: 98, energy_share_percentage: 28 },
    carbs: { grams: 120, energy_share_percentage: 34 },
    fat: { grams: 55, energy_share_percentage: 38 },
  },
};

describe("DayNutritionPreviewPanel", () => {
  it("renders logged calories, meal contributions, and macro shares", () => {
    render(<DayNutritionPreviewPanel preview={preview} />);
    expect(screen.getByRole("heading", { name: "Today's nutrition" })).toBeTruthy();
    expect(screen.getByText("2026-09-07")).toBeTruthy();
    expect(screen.getByText("1450 kcal logged")).toBeTruthy();
    expect(screen.getByText("Breakfast")).toBeTruthy();
    expect(screen.getByText("400 kcal")).toBeTruthy();
    expect(screen.getByTestId("breakfast-segment").style.width).toBe(
      `${String(preview.meals[0]?.share_percentage)}%`,
    );
    expect(screen.getByText("28% · 98 g")).toBeTruthy();
    expect(screen.getByTestId("protein-bar-fill").style.width).toBe("28%");
  });

  it("renders a zero-total empty state", () => {
    render(
      <DayNutritionPreviewPanel
        preview={{
          ...preview,
          total_calories: 0,
          meals: preview.meals.map((meal) => ({ ...meal, calories: 0, share_percentage: 0 })),
        }}
      />,
    );
    expect(screen.getByText("0 kcal logged")).toBeTruthy();
    expect(screen.getByText("No calories logged for this date.")).toBeTruthy();
  });

  it("renders daily aggregates as other without inventing meals", () => {
    render(
      <DayNutritionPreviewPanel
        preview={{
          ...preview,
          meals: [{ meal: "other", calories: 1450, share_percentage: 100 }],
        }}
      />,
    );
    expect(screen.getByText("Other / unspecified")).toBeTruthy();
    expect(screen.getByTestId("other-segment").style.width).toBe("100%");
  });
});
