/** @vitest-environment jsdom */

import { textColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WeightPredictionSummary } from "./WeightPredictionSummary.tsx";

describe("WeightPredictionSummary", () => {
  it("shows rate-derived fields with period deltas", () => {
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

    expect(screen.getByText("-0.3 kg/wk")).toBeInTheDocument();
    expect(screen.getByText("-330 kcal/day")).toBeInTheDocument();
    expect(screen.getByText("7-Day Change")).toBeInTheDocument();
    expect(screen.getByText("-1.2 kg")).toBeInTheDocument();
    expect(screen.getByText("-0.3 kg/wk").style.color).toBe(
      `rgb(${Number.parseInt(textColors.secondary.slice(1, 3), 16)}, ${Number.parseInt(textColors.secondary.slice(3, 5), 16)}, ${Number.parseInt(textColors.secondary.slice(5, 7), 16)})`,
    );
  });

  it("shows period deltas when rate is unavailable", () => {
    render(
      <WeightPredictionSummary
        prediction={{
          ratePerWeek: null,
          rateConfidence: null,
          impliedDailyCalories: null,
          periodDeltas: { days7: -0.4, days14: -0.8, days30: null },
          goal: null,
          projectionLine: [],
        }}
      />,
    );

    expect(screen.getByText("7-Day Change")).toBeInTheDocument();
    expect(screen.getByText("-0.4 kg")).toBeInTheDocument();
    expect(screen.getByText("14-Day Change")).toBeInTheDocument();
    expect(screen.queryByText("Rate")).not.toBeInTheDocument();
  });

  it("shows goal info when rate is unavailable", () => {
    render(
      <WeightPredictionSummary
        prediction={{
          ratePerWeek: null,
          rateConfidence: null,
          impliedDailyCalories: null,
          periodDeltas: { days7: null, days14: null, days30: null },
          goal: { goalWeightKg: 75, remainingKg: -5, estimatedDate: null, daysRemaining: null },
          projectionLine: [],
        }}
      />,
    );

    expect(screen.getByText(/75\.0 kg — estimate unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Rate")).not.toBeInTheDocument();
  });

  it("shows an empty-state message when no rate or goal is available", () => {
    render(
      <WeightPredictionSummary
        prediction={{
          ratePerWeek: null,
          rateConfidence: null,
          impliedDailyCalories: null,
          periodDeltas: { days7: null, days14: null, days30: null },
          goal: null,
          projectionLine: [],
        }}
      />,
    );

    expect(
      screen.getByText("Not enough weigh-in data to estimate weight trend yet."),
    ).toBeInTheDocument();
  });

  it("shows a different empty-state message when weight trend data exists", () => {
    render(
      <WeightPredictionSummary
        hasWeightTrendData
        prediction={{
          ratePerWeek: null,
          rateConfidence: null,
          impliedDailyCalories: null,
          periodDeltas: { days7: null, days14: null, days30: null },
          goal: null,
          projectionLine: [],
        }}
      />,
    );

    expect(
      screen.getByText(
        "Weight trend is available, but a prediction could not be calculated from the current data.",
      ),
    ).toBeInTheDocument();
  });
});
