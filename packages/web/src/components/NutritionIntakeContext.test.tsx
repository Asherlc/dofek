// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NutritionIntakeContext } from "./NutritionIntakeContext";

const overTargetContext = {
  observedCalories: 4259,
  target: {
    calories: 2450,
    type: "configured" as const,
    label: "Configured daily logged-intake target",
  },
  scale: {
    maximumCalories: 4259,
    observedPercentage: 100,
    targetPercentage: (2450 / 4259) * 100,
  },
  comparison: {
    status: "above_target" as const,
    differenceCalories: 1809,
    message:
      "Observed logged intake is 1,809 kcal above the configured daily logged-intake target.",
  },
  limitation:
    "This target describes logged intake only; it is not an estimate of energy expenditure or calorie balance.",
};

describe("NutritionIntakeContext", () => {
  it("keeps over-target intake on a neutral, two-value scale", () => {
    render(<NutritionIntakeContext context={overTargetContext} />);

    expect(screen.getByText("Logged intake")).toBeTruthy();
    expect(screen.getByText("4,259 kcal")).toBeTruthy();
    expect(screen.getByText("Configured daily logged-intake target: 2,450 kcal")).toBeTruthy();
    expect(screen.getByText(overTargetContext.comparison.message)).toBeTruthy();
    expect(screen.getByText(overTargetContext.limitation)).toBeTruthy();
    expect(screen.queryByText(/over goal/i)).toBeNull();

    const meter = screen.getByRole("meter", {
      name: /Logged intake: 4,259 kcal.*2,450 kcal.*1,809 kcal above/i,
    });
    expect(meter).toHaveAttribute("value", "4259");
    expect(meter).toHaveAttribute("max", "4259");

    expect(screen.getByTestId("calorie-scale-observed")).toHaveStyle({ width: "100%" });
    expect(screen.getByTestId("calorie-scale-target")).toHaveStyle({
      left: `${(2450 / 4259) * 100}%`,
    });
    expect(screen.getByTestId("calorie-scale-observed")).not.toHaveClass("bg-red-500");
  });
});
