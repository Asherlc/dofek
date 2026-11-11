/** @vitest-environment jsdom */

import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildChartTable } from "./chart-accessibility.ts";
import { SportVolumeChart } from "./SportVolumeChart.tsx";

interface VolumeOption extends Record<string, unknown> {
  yAxis: { name: string; axisLabel: { formatter: (value: number) => string } };
  tooltip: { valueFormatter?: (value: number) => string };
  series: { data: unknown[] }[];
}
const chart = vi.hoisted(() => {
  const state: { option?: VolumeOption } = {};
  return state;
});
vi.mock("../lib/unitContext.ts", () => ({ useUnitConverter: () => new UnitConverter("metric") }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    training: {
      sportVolume: {
        useQuery: (input: { sport?: string; metric: string }) => ({
          data: {
            sport: input.sport ?? "running",
            sports: ["running", "swimming", "yoga"],
            metric: input.metric,
            unit: input.metric === "distance" ? "km" : input.metric === "elevation" ? "m" : "min",
            weeks: [
              { week: "2026-10-19", value: input.metric === "distance" ? null : 85.86666666666666 },
            ],
          },
          isLoading: false,
          isFetching: false,
          error: null,
        }),
      },
    },
  },
}));
vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: VolumeOption }) => {
    chart.option = option;
    return <div data-testid="chart">{JSON.stringify(option.series[0]?.data)}</div>;
  },
}));
afterEach(cleanup);
it("switches volume measures and retains unknown distance", () => {
  render(<SportVolumeChart days={30} sport="running" />);
  expect(screen.getByTestId("chart").textContent).toContain(",85.86666666666666]");
  fireEvent.change(screen.getByLabelText("Volume metric"), { target: { value: "distance" } });
  expect(screen.getByTestId("chart").textContent).toContain("null");
});
it("formats duration axes, tooltips, and chart data as hours:minutes", () => {
  render(<SportVolumeChart days={30} sport="cycling" />);
  expect(chart.option?.yAxis.name).toBe("Time (h:mm)");
  expect(chart.option?.yAxis.axisLabel.formatter(1200)).toBe("20:00");
  expect(chart.option?.tooltip.valueFormatter?.(85.86666666666666)).toBe("1:26");
  expect(buildChartTable(chart.option ?? {}).rows[0]?.value).toBe("1:26");
});
it("rounds numeric volume axes, tooltips, and chart data to zero decimals", () => {
  render(<SportVolumeChart days={30} sport="cycling" />);
  fireEvent.change(screen.getByLabelText("Volume metric"), { target: { value: "elevation" } });
  expect(chart.option?.yAxis.axisLabel.formatter(200)).toBe("200");
  expect(chart.option?.tooltip.valueFormatter?.(85.86666666666666)).toBe("86");
  expect(buildChartTable(chart.option ?? {}).rows[0]?.value).toBe("86");
});
it("offers recorded sports and resets the metric for a time-only sport", () => {
  render(<SportVolumeChart days={null} />);
  fireEvent.change(screen.getByLabelText("Volume metric"), { target: { value: "distance" } });
  fireEvent.change(screen.getByLabelText("Volume sport"), { target: { value: "yoga" } });
  expect(screen.getByLabelText("Volume metric")).toHaveValue("time");
  expect(screen.queryByRole("option", { name: "Distance" })).toBeNull();
});
