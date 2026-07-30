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
          status: "available",
          estimatedTdee: 2_250,
          estimateRange: { minimum: 2_180, maximum: 2_320 },
          unavailableReason: null,
          evidence: {
            selectedWindowDays: 90,
            fitWindowDays: 28,
            minimumCalorieDays: 20,
            observedDays: 90,
            calorieDays: 82,
            weightDays: 45,
            acceptedWindows: 30,
            excludedDays: {
              missingCalories: 6,
              sourceConflict: 2,
              lowerPrioritySources: 3,
            },
          },
          dailyData: [
            {
              date: "2026-07-24",
              caloriesIn: 2_100,
              nutritionStatus: "available",
              lowerPrioritySourcesExcluded: false,
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
    expect(
      screen.getByText("Observed rolling range: 2180–2320 central-calorie-rate-unit"),
    ).toBeTruthy();
    expect(screen.getByText("90-day evaluation · 90 accessible calendar days")).toBeTruthy();
    expect(screen.getByText("28-day fit · at least 20 usable calorie days")).toBeTruthy();
    expect(screen.getByText("82 calorie days · 45 weight days · 30 accepted windows")).toBeTruthy();
    expect(
      screen.getByText(
        "Excluded: 6 missing calorie days · 2 source-conflict days · 3 days with lower-priority sources",
      ),
    ).toBeTruthy();
  });

  it("shows the server-authored unavailable reason and evidence", () => {
    render(
      <AdaptiveTdeeChart
        data={{
          status: "unavailable",
          estimatedTdee: null,
          estimateRange: null,
          unavailableReason: "No body-weight measurements are available in the selected period.",
          evidence: {
            selectedWindowDays: 90,
            fitWindowDays: 28,
            minimumCalorieDays: 20,
            observedDays: 90,
            calorieDays: 90,
            weightDays: 0,
            acceptedWindows: 0,
            excludedDays: {
              missingCalories: 0,
              sourceConflict: 0,
              lowerPrioritySources: 0,
            },
          },
          dailyData: [],
        }}
      />,
    );

    expect(
      screen.getByText("No body-weight measurements are available in the selected period."),
    ).toBeTruthy();
    expect(screen.getByText("28-day fit · at least 20 usable calorie days")).toBeTruthy();
    expect(screen.getByText("90 calorie days · 0 weight days · 0 accepted windows")).toBeTruthy();
  });
});
