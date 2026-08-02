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
    label: "Configured daily logged-intake target",
  },
  scale: {
    maximumCalories: 4259,
    observedPercentage: 100,
    targetPercentage: 57.525240666823194,
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

const targetAtScaleMaximumContext = {
  ...overTargetContext,
  scale: {
    maximumCalories: 2450,
    observedPercentage: 173.83673469387756,
    targetPercentage: 100,
  },
} satisfies SelectedDateNutritionIntakeContext;

const punctuationlessContext = {
  ...overTargetContext,
  comparison: {
    ...overTargetContext.comparison,
    message: "Observed logged intake is 1,809 kcal above the configured daily logged-intake target",
  },
} satisfies SelectedDateNutritionIntakeContext;

describe("NutritionIntakeContext", () => {
  it("keeps over-target intake accessible and neutral", () => {
    render(<NutritionIntakeContext context={overTargetContext} />);

    expect(screen.getByText("Logged intake")).toBeTruthy();
    expect(screen.getByText("4,259 kcal")).toBeTruthy();
    expect(screen.getByText("Configured daily logged-intake target: 2,450 kcal")).toBeTruthy();
    expect(screen.getByText(overTargetContext.comparison.message)).toBeTruthy();
    expect(screen.getByText(overTargetContext.limitation)).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Logged intake: 4,259 kcal. Configured daily logged-intake target: 2,450 kcal. Observed logged intake is 1,809 kcal above the configured daily logged-intake target. Scale: 0 to 4,259 kcal. This target describes logged intake only; it is not an estimate of energy expenditure or calorie balance.",
      ),
    ).toBeTruthy();
  });

  it("clamps over-target geometry when the target is at the scale maximum", () => {
    render(<NutritionIntakeContext context={targetAtScaleMaximumContext} />);

    expect(screen.getByTestId("calorie-scale-observed").style.width).toBe("100%");
    expect(screen.getByTestId("calorie-scale-target").style.left).toBe("100%");
    expect(screen.getByTestId("calorie-scale-target").style.marginLeft).toBe("-2px");
  });

  it("separates comparison and scale context in the accessibility label", () => {
    render(<NutritionIntakeContext context={punctuationlessContext} />);

    expect(
      screen.getByLabelText(/configured daily logged-intake target\. Scale: 0 to/i),
    ).toBeTruthy();
  });
});
