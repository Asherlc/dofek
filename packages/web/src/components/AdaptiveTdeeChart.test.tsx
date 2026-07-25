/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let chartProps: {
  option: {
    series?: Array<{ name?: string }>;
    yAxis?: Array<{ name?: string }>;
  };
  emptyMessage?: string;
} | null = null;

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: (props: {
    option: {
      series?: Array<{ name?: string }>;
      yAxis?: Array<{ name?: string }>;
    };
    emptyMessage?: string;
  }) => {
    chartProps = props;
    return <div>{props.emptyMessage}</div>;
  },
}));

vi.mock("../lib/unitContext.ts", () => ({
  useUnitConverter: () => ({
    calorieLabel: "central-calorie-unit",
    caloriesPerDayLabel: "central-calorie-rate-unit",
    convertWeight: (value: number) => value,
    weightLabel: "kg",
  }),
}));

import { AdaptiveTdeeChart } from "./AdaptiveTdeeChart.tsx";

describe("AdaptiveTdeeChart", () => {
  beforeEach(() => {
    chartProps = null;
  });

  it("uses a readable Total Daily Energy Expenditure label in the empty state", () => {
    render(<AdaptiveTdeeChart data={undefined} />);

    expect(
      screen.getByText(
        "Need calorie tracking and weight measurements to estimate Total Daily Energy Expenditure (TDEE)",
      ),
    ).toBeTruthy();
  });

  it("uses readable Total Daily Energy Expenditure labels in the legend and summary", () => {
    render(
      <AdaptiveTdeeChart
        data={{
          estimatedTdee: 2_250,
          confidence: 0.82,
          dataPoints: 30,
          dailyData: [
            {
              date: "2026-07-24",
              caloriesIn: 2_100,
              weightKg: 75,
              smoothedWeight: 74.8,
              estimatedTdee: 2_250,
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByText("central-calorie-rate-unit estimated total daily energy expenditure (TDEE)"),
    ).toBeTruthy();
    expect(chartProps?.option.yAxis?.[0]?.name).toBe("central-calorie-unit");
    expect(chartProps?.option.series?.map((series) => series.name)).toContain(
      "Estimated Total Daily Energy Expenditure (TDEE)",
    );
  });
});
