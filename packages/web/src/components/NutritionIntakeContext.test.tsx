// @vitest-environment jsdom

import type { SelectedDateNutritionIntakeContext } from "@dofek/nutrition/selected-date-summary";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NutritionIntakeContext } from "./NutritionIntakeContext";

const overTargetContext = {
  observedCalories: 4259,
  target: {
    calories: 2450,
    type: "configured",
    label: "Target",
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
} satisfies SelectedDateNutritionIntakeContext;

describe("NutritionIntakeContext", () => {
  it("keeps over-target intake on a neutral, two-value scale", () => {
    render(<NutritionIntakeContext context={overTargetContext} />);

    expect(screen.getByText("Calories")).toBeTruthy();
    expect(screen.getAllByText("4,259 kcal")).toHaveLength(2);
    expect(screen.getByText("Target: 2,450 kcal")).toBeTruthy();

    const meter = screen.getByRole("meter", {
      name: /Calories: 4,259 kcal.*2,450 kcal.*Scale: 0 to 4,259 kcal/i,
    });
    expect(meter).toHaveAttribute("value", "4259");
    expect(meter).toHaveAttribute("max", "4259");

    expect(screen.getByTestId("calorie-scale-observed")).toHaveStyle({ width: "100%" });
    expect(screen.getByTestId("calorie-scale-target")).toHaveStyle({
      left: "57.525240666823194%",
    });
  });

  it("uses a unique heading id for each rendered context", () => {
    render(
      <>
        <NutritionIntakeContext context={overTargetContext} />
        <NutritionIntakeContext context={overTargetContext} />
      </>,
    );

    const headings = screen.getAllByRole("heading", { name: "Calories" });
    expect(headings).toHaveLength(2);
    expect(headings[0]?.id).toBeTruthy();
    expect(headings[0]?.id).not.toBe(headings[1]?.id);
  });
});
