/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DayNutritionPreviewPanel } from "./day-nutrition-preview.tsx";

const preview = {
  date: "2026-09-07",
  total_calories: 1450,
  protein_g: 98,
  carbs_g: 120,
  fat_g: 55,
  calorie_goal: {
    target: 2200,
    remaining: 750,
    over: 0,
    progress_percentage: 65.9,
    type: "configured" as const,
  },
  macros: {
    protein: { grams: 98, energy_share_percentage: 28 },
    carbs: { grams: 120, energy_share_percentage: 34 },
    fat: { grams: 55, energy_share_percentage: 38 },
  },
};

describe("DayNutritionPreviewPanel", () => {
  it("renders calorie progress and macro bars from the server preview", () => {
    render(<DayNutritionPreviewPanel preview={preview} />);

    expect(screen.getByRole("heading", { name: "Today's nutrition" })).toBeTruthy();
    expect(screen.getByText("2026-09-07")).toBeTruthy();
    expect(screen.getByText("1450 cal · 750 remaining")).toBeTruthy();
    expect(screen.getByText("28% · 98 g")).toBeTruthy();
    expect(screen.getByTestId("protein-bar-fill").getAttribute("style")).toContain("width: 28%");
    expect(screen.getByTestId("calories-bar-fill").getAttribute("style")).toContain("width: 65.9%");
  });

  it("shows over-target calories when intake exceeds the goal", () => {
    render(
      <DayNutritionPreviewPanel
        preview={{
          ...preview,
          total_calories: 2400,
          calorie_goal: {
            ...preview.calorie_goal,
            remaining: 0,
            over: 200,
            progress_percentage: 100,
          },
        }}
      />,
    );

    expect(screen.getByText("2400 cal · 200 over target")).toBeTruthy();
  });
});
