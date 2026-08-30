/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import type { StressResult } from "dofek-server/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const chartProps = vi.hoisted(() => vi.fn());

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: (props: Record<string, unknown>) => {
    chartProps(props);
    return <div data-testid="stress-chart" />;
  },
}));

import { StressChart } from "./StressChart.tsx";

const todayStress: StressResult = {
  daily: [
    {
      date: "2026-08-26",
      stressScore: 1.2,
      hrvDeviation: null,
      restingHrDeviation: null,
      sleepEfficiency: null,
    },
    {
      date: "2026-08-27",
      stressScore: 2.3,
      hrvDeviation: 1.5,
      restingHrDeviation: -0.8,
      sleepEfficiency: 91,
    },
  ],
  weekly: [
    { weekStart: "2026-08-28", cumulativeStress: 8.4, avgDailyStress: 1.7, highStressDays: 2 },
  ],
  latestScore: 2.3,
  trend: "worsening",
};

afterEach(() => {
  chartProps.mockReset();
  vi.useRealTimers();
});

function latestOption(): Record<string, unknown> {
  const props = chartProps.mock.calls.at(-1)?.[0];
  const option = props?.option;
  if (!option || typeof option !== "object") {
    throw new Error("Expected StressChart to supply chart options");
  }
  return option;
}

function tooltipFormatter(option: Record<string, unknown>) {
  const tooltip = option.tooltip;
  if (!tooltip || typeof tooltip !== "object") throw new Error("Expected a chart tooltip");
  const formatter = Reflect.get(tooltip, "formatter");
  if (typeof formatter !== "function") throw new Error("Expected a tooltip formatter");
  return (params: Array<{ dataIndex: number }>) => {
    const value = Reflect.apply(formatter, undefined, [params]);
    if (typeof value !== "string") throw new Error("Expected the tooltip formatter to return text");
    return value;
  };
}

describe("StressChart", () => {
  it("renders chart loading and empty states", () => {
    const { rerender } = render(<StressChart data={undefined} loading />);
    expect(chartProps).toHaveBeenLastCalledWith(expect.objectContaining({ loading: true }));

    rerender(<StressChart data={undefined} />);
    expect(chartProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ empty: true, emptyMessage: "No stress data" }),
    );
  });

  it("shows today’s worsening stress and formats all available tooltip measurements", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00"));

    render(<StressChart data={todayStress} />);

    expect(screen.getByText("↑ Worsening")).toBeDefined();
    expect(screen.getByText("This week: 8.4 cumulative")).toBeDefined();
    const option = latestOption();
    expect(option.graphic).toMatchObject([{ style: { text: "Today: 2.3 High ↑" } }]);

    const formatter = tooltipFormatter(option);
    expect(formatter([{ dataIndex: 1 }])).toContain(
      "Heart rate variability deviation: <b>+1.5</b>σ",
    );
    expect(formatter([{ dataIndex: 1 }])).toContain("Resting heart rate deviation: <b>-0.8</b>σ");
    expect(formatter([{ dataIndex: 1 }])).toContain("Sleep efficiency: <b>91%</b>");
    expect(formatter([])).toBe("");
    expect(formatter([{ dataIndex: 99 }])).toBe("");
  });

  it("renders stable historic data without a current-week annotation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00"));
    const historic: StressResult = {
      ...todayStress,
      daily: [
        {
          date: "2026-08-01",
          stressScore: 1.2,
          hrvDeviation: null,
          restingHrDeviation: null,
          sleepEfficiency: null,
        },
      ],
      weekly: [
        { weekStart: "2026-08-03", cumulativeStress: 8.4, avgDailyStress: 1.7, highStressDays: 2 },
      ],
      trend: "stable",
    };

    render(<StressChart data={historic} />);

    expect(screen.getByText("→ Stable")).toBeDefined();
    expect(screen.queryByText(/This week:/)).toBeNull();
    expect(latestOption().graphic).toEqual([]);
  });
});
