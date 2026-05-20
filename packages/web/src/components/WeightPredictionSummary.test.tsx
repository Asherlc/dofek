/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WeightPredictionSummary } from "./WeightPredictionSummary.tsx";

describe("WeightPredictionSummary", () => {
  it("shows rate-derived fields without a separate 7-day change row", () => {
    render(
      <WeightPredictionSummary
        prediction={{
          ratePerWeek: -0.3,
          rateConfidence: 0.92,
          impliedDailyCalories: -330,
          periodDeltas: { days7: -1.2, days14: -1.8, days30: null },
          goal: { goalWeightKg: 82, remainingKg: -3, estimatedDate: null, daysRemaining: null },
          projectionLine: [],
        }}
      />,
    );

    expect(screen.getByText("-0.3 kg/wk")).toBeDefined();
    expect(screen.getByText("-330 kcal/day")).toBeDefined();
    expect(screen.queryByText("7-Day Change")).toBeNull();
  });
});
