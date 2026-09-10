// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type ChartProps = {
  empty: boolean;
  loading?: boolean;
  option: {
    series: Array<{ data: Array<[string, number | null]> }>;
    tooltip: { formatter: (params: unknown[]) => string };
    yAxis: Array<{ max?: number }>;
  };
};

const mockChart = vi.hoisted(() => vi.fn());

function isChartProps(value: unknown): value is ChartProps {
  if (!value || typeof value !== "object" || !("empty" in value) || !("option" in value)) {
    return false;
  }
  if (typeof value.empty !== "boolean" || !value.option || typeof value.option !== "object") {
    return false;
  }
  return "series" in value.option && "tooltip" in value.option && "yAxis" in value.option;
}

function capturedChartProps(): ChartProps {
  const props = mockChart.mock.calls[0]?.[0];
  if (!isChartProps(props)) throw new Error("Expected the chart to render.");
  return props;
}

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: (props: unknown) => {
    mockChart(props);
    return <div data-testid="hrv-chart" />;
  },
}));

import { HrvVariabilityChart } from "./HrvVariabilityChart.tsx";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HrvVariabilityChart", () => {
  it("renders an empty, loading chart with the minimum variability range", () => {
    render(<HrvVariabilityChart data={[]} loading />);

    const props = capturedChartProps();
    expect(props.empty).toBe(true);
    expect(props.loading).toBe(true);
    expect(props.option.yAxis[1]?.max).toBe(15);
  });

  it("builds chart data and safely formats populated and empty tooltips", () => {
    render(
      <HrvVariabilityChart
        data={[
          {
            date: "2026-01-01",
            hrv: 52,
            rollingCoefficientOfVariation: 16.2,
            rollingMean: 50,
          },
          {
            date: "2026-01-02",
            hrv: null,
            rollingCoefficientOfVariation: null,
            rollingMean: null,
          },
        ]}
      />,
    );

    const props = capturedChartProps();
    expect(props.empty).toBe(false);
    expect(props.option.yAxis[1]?.max).toBe(17);
    expect(props.option.series[3]?.data).toEqual([
      ["2026-01-01", 52],
      ["2026-01-02", null],
    ]);
    expect(props.option.series[4]?.data).toEqual([
      ["2026-01-01", 16.2],
      ["2026-01-02", null],
    ]);
    expect(props.option.tooltip.formatter([])).toBe("");
    expect(props.option.tooltip.formatter([undefined])).toBe("");
    expect(
      props.option.tooltip.formatter([
        {
          seriesName: "Heart Rate Variability",
          data: ["2026-01-01", 52],
          color: "<blue>",
        },
        {
          seriesName: "Rolling Variability",
          data: ["2026-01-01", 16.2],
          color: "red",
        },
        {
          seriesName: "Heart Rate Variability",
          data: ["2026-01-01", null],
          color: "green",
        },
      ]),
    ).toContain("Rolling Variability");
  });
});
