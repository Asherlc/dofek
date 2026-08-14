/** @vitest-environment jsdom */

import { chartColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import type { ProgressiveOverloadRow } from "dofek-server/types";
import { describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: Record<string, unknown> }) => (
    <div data-testid="volume-trend-chart" data-option={JSON.stringify(option)} />
  ),
}));

import { ProgressiveOverloadCards } from "./ProgressiveOverloadCards.tsx";

const evidence = {
  exerciseName: "Back Squat",
  observations: [
    { week: "2026-01-05", totalVolumeKg: 4_800 },
    { week: "2026-01-19", totalVolumeKg: 5_100 },
    { week: "2026-02-02", totalVolumeKg: 5_450 },
    { week: "2026-02-09", totalVolumeKg: 5_250 },
  ],
  period: {
    startWeek: "2026-01-05",
    endWeek: "2026-02-09",
    observationCount: 4,
    elapsedWeekCount: 6,
  },
  slopeKgPerWeek: 100,
  trend: "increasing" as const,
  uncertainty: {
    availability: "available" as const,
    level: 0.95 as const,
    method: "residual_circular_moving_block_bootstrap" as const,
    methodLabel: "95% moving-block interval",
    lowerKgPerWeek: -25,
    upperKgPerWeek: 240,
    statement: "The interval reflects variation and short-range dependence among recorded weeks.",
  },
  interpretation:
    "Recorded weekly volume increased over this period. An increase is not inherently good or bad.",
  deloadContext:
    "Recorded volume cannot distinguish a planned deload from missed training or incomplete data.",
} satisfies ProgressiveOverloadRow;

describe("ProgressiveOverloadCards", () => {
  it("renders complete server-authored evidence without positive or negative status styling", () => {
    render(
      <ProgressiveOverloadCards
        exercises={[
          evidence,
          {
            ...evidence,
            exerciseName: "Deadlift",
            slopeKgPerWeek: -150,
            trend: "decreasing" as const,
            interpretation:
              "Recorded weekly volume decreased over this period. A decrease is not inherently good or bad.",
          },
        ]}
      />,
    );

    expect(screen.getByText("Back Squat")).toBeInTheDocument();
    expect(screen.getAllByText("Jan 5, 2026 – Feb 9, 2026").length).toBe(2);
    expect(screen.getAllByText("4 recorded weeks across 6 calendar weeks").length).toBe(2);
    expect(screen.getAllByText("95% moving-block interval: -25.0 to 240.0 kg/week").length).toBe(2);
    expect(screen.getAllByText(evidence.uncertainty.statement).length).toBe(2);
    expect(screen.getByText(evidence.interpretation)).toHaveClass("text-muted");
    expect(screen.getAllByText(evidence.deloadContext).length).toBe(2);
    expect(screen.getByText("Increasing 100.0 kg/week")).toHaveClass("text-muted");
    expect(screen.getByText("Decreasing 150.0 kg/week")).toHaveClass("text-muted");
    expect(screen.queryByText("\u2191")).toBeNull();
    expect(screen.queryByText("\u2193")).toBeNull();

    const chartColorsUsed = screen.getAllByTestId("volume-trend-chart").map((chart) => {
      const option = JSON.parse(chart.dataset.option ?? "{}");
      return option.series[0].lineStyle.color;
    });
    expect(chartColorsUsed).toEqual([chartColors.blue, chartColors.blue]);
  });

  it("renders an explicit unavailable uncertainty reason", () => {
    render(
      <ProgressiveOverloadCards
        exercises={[
          {
            ...evidence,
            slopeKgPerWeek: 0,
            trend: "stable" as const,
            uncertainty: {
              availability: "unavailable" as const,
              level: 0.95 as const,
              method: "residual_circular_moving_block_bootstrap" as const,
              methodLabel: "95% moving-block interval",
              reason: "insufficient_observations" as const,
              statement: "Uncertainty needs at least 4 recorded weeks; this estimate has 3.",
            },
            interpretation:
              "Recorded weekly volume was stable over this period. Stability is not inherently good or bad.",
          },
        ]}
      />,
    );

    expect(screen.getByText("Stable 0.0 kg/week")).toHaveClass("text-muted");
    expect(
      screen.getByText("Uncertainty needs at least 4 recorded weeks; this estimate has 3."),
    ).toBeInTheDocument();
  });

  it("formats weekly volume slopes in the selected weight unit", () => {
    render(
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <ProgressiveOverloadCards
          exercises={[
            {
              ...evidence,
              slopeKgPerWeek: 1,
              trend: "increasing" as const,
              uncertainty: {
                ...evidence.uncertainty,
                lowerKgPerWeek: -1,
                upperKgPerWeek: 2,
              },
            },
          ]}
        />
      </UnitContext.Provider>,
    );

    expect(screen.getByText("Increasing 2.2 lb/week")).toHaveClass("text-muted");
    expect(screen.getByText("95% moving-block interval: -2.2 to 4.4 lb/week")).toBeInTheDocument();
  });
});
