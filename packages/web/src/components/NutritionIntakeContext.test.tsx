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

const punctuationlessContext = {
  ...overTargetContext,
  comparison: {
    ...overTargetContext.comparison,
    message: "Observed logged intake is 1,809 kcal above the configured daily logged-intake target",
  },
} satisfies SelectedDateNutritionIntakeContext;

describe("NutritionIntakeContext", () => {
  it("keeps over-target intake on a neutral, two-value scale", () => {
    render(<NutritionIntakeContext context={overTargetContext} />);

    expect(screen.getByText("Logged intake")).toBeTruthy();
    expect(screen.getByText("4,259 kcal")).toBeTruthy();
    expect(screen.getByText("Configured daily logged-intake target: 2,450 kcal")).toBeTruthy();
    expect(screen.getByText(overTargetContext.comparison.message)).toBeTruthy();
    expect(screen.getByText(overTargetContext.limitation)).toBeTruthy();

    const meter = screen.getByRole("meter", {
      name: /Logged intake: 4,259 kcal.*2,450 kcal.*1,809 kcal above.*Scale: 0 to 4,259 kcal.*This target describes logged intake only/i,
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

    const headings = screen.getAllByRole("heading", { name: "Logged intake" });
    expect(headings).toHaveLength(2);
    expect(headings[0]?.id).toBeTruthy();
    expect(headings[0]?.id).not.toBe(headings[1]?.id);
  });

  it("separates comparison and scale context in the accessible label", () => {
    render(<NutritionIntakeContext context={punctuationlessContext} />);

    expect(
      screen.getByRole("meter", {
        name: /configured daily logged-intake target\. Scale: 0 to/i,
      }),
    ).toBeTruthy();
  });
});
