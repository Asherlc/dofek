/** @vitest-environment jsdom */

import { chartColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: Record<string, unknown> }) => (
    <div data-testid="volume-trend-chart" data-option={JSON.stringify(option)} />
  ),
}));

import { ProgressiveOverloadCards } from "./ProgressiveOverloadCards.tsx";

describe("ProgressiveOverloadCards", () => {
  it("describes volume direction without positive or negative status styling", () => {
    render(
      <ProgressiveOverloadCards
        exercises={[
          {
            exerciseName: "Back Squat",
            weeklyVolumes: [4800, 5100, 5450],
            slopeKgPerWeek: 325,
            trend: "increasing",
          },
          {
            exerciseName: "Deadlift",
            weeklyVolumes: [4200, 4050, 3900],
            slopeKgPerWeek: -150,
            trend: "decreasing",
          },
        ]}
      />,
    );

    expect(screen.getByText("Increasing 325.0 kg/week")).toHaveClass("text-muted");
    expect(screen.getByText("Decreasing 150.0 kg/week")).toHaveClass("text-muted");
    expect(screen.queryByText("\u2191")).toBeNull();
    expect(screen.queryByText("\u2193")).toBeNull();

    const chartColorsUsed = screen.getAllByTestId("volume-trend-chart").map((chart) => {
      const option = JSON.parse(chart.dataset.option ?? "{}");
      return option.series[0].lineStyle.color;
    });
    expect(chartColorsUsed).toEqual([chartColors.blue, chartColors.blue]);
  });

  it("describes an exact-zero slope as stable", () => {
    render(
      <ProgressiveOverloadCards
        exercises={[
          {
            exerciseName: "Row",
            weeklyVolumes: [500, 500, 500],
            slopeKgPerWeek: 0,
            trend: "stable",
          },
        ]}
      />,
    );

    expect(screen.getByText("Stable 0.0 kg/week")).toHaveClass("text-muted");
  });
});
