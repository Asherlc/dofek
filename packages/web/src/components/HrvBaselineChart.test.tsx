// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HrvBaselineChart } from "./HrvBaselineChart.tsx";

interface ChartOption {
  legend: { data: { name: string }[] };
  yAxis: { name: string }[];
  series: { name: string; yAxisIndex?: number; data: unknown[] }[];
}

const chartOptions: ChartOption[] = [];

vi.mock("echarts-for-react", () => ({
  default: ({ option }: { option: ChartOption }) => {
    chartOptions.push(option);
    return <div data-testid="echarts-mock" />;
  },
}));

describe("HrvBaselineChart", () => {
  it("plots resting heart rate on the same chart as heart rate variability", () => {
    render(
      <HrvBaselineChart
        data={[
          {
            date: "2026-05-20",
            hrv: 55,
            resting_hr: 52,
            mean_60d: 54,
            sd_60d: 4,
            mean_7d: 56,
            resting_hr_mean_7d: 53,
          },
          {
            date: "2026-05-21",
            hrv: 58,
            resting_hr: 54,
            mean_60d: 55,
            sd_60d: 3,
            mean_7d: 57,
            resting_hr_mean_7d: 53.5,
          },
        ]}
      />,
    );

    expect(screen.getByTestId("echarts-mock")).toBeDefined();
    const option = chartOptions[0];
    if (!option) throw new Error("Expected chart option to be captured");

    expect(option.legend.data.map((item) => item.name)).toContain("Resting Heart Rate");
    expect(option.yAxis[1]?.name).toBe("Resting Heart Rate (bpm)");
    expect(option.series.find((series) => series.name === "Resting Heart Rate")).toMatchObject({
      yAxisIndex: 1,
      data: [
        ["2026-05-20", 52],
        ["2026-05-21", 54],
      ],
    });
    expect(
      option.series.find((series) => series.name === "Resting Heart Rate 7d Avg"),
    ).toMatchObject({
      yAxisIndex: 1,
      data: [
        ["2026-05-20", 53],
        ["2026-05-21", 53.5],
      ],
    });
  });
});
