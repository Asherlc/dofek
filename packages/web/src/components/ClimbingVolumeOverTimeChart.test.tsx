/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ClimbingVolumeOverTimeChart } from "./ClimbingVolumeOverTimeChart.tsx";
import { buildChartTable } from "./chart-accessibility.ts";

interface ChartOption {
  series: { data: unknown[] }[];
  yAxis: {
    name: string;
    min?: number;
    max?: number;
    interval?: number;
    axisLabel: { formatter?: (value: number) => string };
  };
  tooltip: { formatter?: (params: { dataIndex: number }[]) => string };
}

const chart = vi.hoisted(() => {
  const option: ChartOption = { series: [], yAxis: { name: "", axisLabel: {} }, tooltip: {} };
  return { option };
});

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: ChartOption }) => {
    chart.option = option;
    return <div data-testid="chart">{JSON.stringify(option.series[0]?.data)}</div>;
  },
}));
afterEach(cleanup);
it("switches between attempts and time without turning unknown values into zero", () => {
  render(
    <ClimbingVolumeOverTimeChart data={[{ week: "2026-01-05", attempts: null, minutes: 60 }]} />,
  );
  expect(screen.getByTestId("chart").textContent).toContain("null");
  fireEvent.change(screen.getByLabelText("Climbing volume metric"), { target: { value: "time" } });
  expect(screen.getByTestId("chart").textContent).toContain(",60]");
});

it.each([
  [60, 60, 60],
  [90, 60, 120],
  [600, 120, 600],
  [601, 120, 720],
])("uses whole-hour grid lines for %s minutes", (minutes, interval, max) => {
  render(<ClimbingVolumeOverTimeChart data={[{ week: "2026-01-05", attempts: 5, minutes }]} />);
  fireEvent.change(screen.getByLabelText("Climbing volume metric"), { target: { value: "time" } });

  expect(chart.option.yAxis.name).toBe("Time (h:mm)");
  expect(chart.option.yAxis.min).toBe(0);
  expect(chart.option.yAxis.interval).toBe(interval);
  expect(chart.option.yAxis.max).toBe(max);
  expect(chart.option.yAxis.axisLabel.formatter?.(0)).toBe("0:00");
  expect(chart.option.yAxis.axisLabel.formatter?.(60)).toBe("1:00");
  expect(chart.option.yAxis.axisLabel.formatter?.(120)).toBe("2:00");
});

it("formats time tooltips and accessible exact values as hours:minutes", () => {
  render(
    <ClimbingVolumeOverTimeChart
      data={[
        { week: "2026-01-05", attempts: 5, minutes: 90 },
        { week: "2026-01-12", attempts: 2, minutes: 45 },
        { week: "2026-01-19", attempts: 0, minutes: 0 },
        { week: "2026-01-26", attempts: null, minutes: null },
      ]}
    />,
  );
  fireEvent.change(screen.getByLabelText("Climbing volume metric"), { target: { value: "time" } });
  expect(chart.option.tooltip.formatter?.([{ dataIndex: 0 }])).toBe(
    "2026-01-05<br/>Time (h:mm): 1:30",
  );
  expect(chart.option.tooltip.formatter?.([{ dataIndex: 1 }])).toBe(
    "2026-01-12<br/>Time (h:mm): 0:45",
  );
  expect(chart.option.tooltip.formatter?.([{ dataIndex: 2 }])).toBe(
    "2026-01-19<br/>Time (h:mm): 0:00",
  );
  expect(chart.option.tooltip.formatter?.([{ dataIndex: 3 }])).toBe(
    "2026-01-26<br/>Time (h:mm): Not recorded",
  );
  expect(chart.option.series[0]?.data).toContainEqual({
    value: ["2026-01-05", 90],
    displayValue: "1:30",
  });
  expect(buildChartTable({ ...chart.option }).rows).toEqual([
    { series: "Time (h:mm)", category: "2026-01-05", value: "1:30" },
    { series: "Time (h:mm)", category: "2026-01-12", value: "0:45" },
    { series: "Time (h:mm)", category: "2026-01-19", value: "0:00" },
    { series: "Time (h:mm)", category: "2026-01-26", value: "Not recorded" },
  ]);

  fireEvent.change(screen.getByLabelText("Climbing volume metric"), {
    target: { value: "attempts" },
  });
  expect(chart.option.yAxis.name).toBe("Attempts");
  expect(chart.option.yAxis.interval).toBeUndefined();
  expect(chart.option.tooltip.formatter?.([{ dataIndex: 0 }])).toBe("2026-01-05<br/>Attempts: 5");
});

it("keeps sub-hour time charts in minutes", () => {
  render(<ClimbingVolumeOverTimeChart data={[{ week: "2026-01-05", attempts: 5, minutes: 59 }]} />);
  fireEvent.change(screen.getByLabelText("Climbing volume metric"), { target: { value: "time" } });
  expect(chart.option.yAxis.name).toBe("Time (minutes)");
  expect(chart.option.yAxis.interval).toBeUndefined();
  expect(chart.option.tooltip.formatter?.([{ dataIndex: 0 }])).toBe(
    "2026-01-05<br/>Time (minutes): 59",
  );
});
