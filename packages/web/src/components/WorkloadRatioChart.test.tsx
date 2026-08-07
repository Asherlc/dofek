/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let chartOption: {
  series?: Array<{ name?: string }>;
  yAxis?: Array<{ name?: string }>;
} | null = null;

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: (props: {
    option: {
      series?: Array<{ name?: string }>;
      yAxis?: Array<{ name?: string }>;
    };
  }) => {
    chartOption = props.option;
    return <div>Training load chart</div>;
  },
}));

import { WorkloadRatioChart } from "./WorkloadRatioChart.tsx";

describe("WorkloadRatioChart", () => {
  beforeEach(() => {
    chartOption = null;
  });

  it("renders the ratio and load windows as neutral descriptive series", () => {
    render(
      <WorkloadRatioChart
        context={{
          label: "Recent-to-baseline workload ratio",
          description: "Descriptive comparison",
          recentDays: 5,
          baselineDays: 20,
        }}
        data={[
          {
            date: "2026-03-28",
            dailyLoad: 100,
            strain: 12.8,
            acuteLoad: 700,
            chronicLoad: 350,
            workloadRatio: 2,
          },
        ]}
      />,
    );

    expect(chartOption?.series?.map((series) => series.name)).toEqual([
      "Recent / baseline",
      "Recent 5-day Load",
      "20-day Baseline Load",
    ]);
    expect(chartOption?.yAxis?.[0]?.name).toBe("Recent / baseline");
    expect(screen.getByText("How this is calculated")).toBeVisible();
    expect(screen.getByText(/Acute-to-chronic workload ratio/)).not.toBeVisible();
  });
});
