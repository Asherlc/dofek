// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { climbingProgressionFixture } from "./climbing-progression-test-helpers.ts";

interface ChartOption {
  xAxis: { show: boolean; data: string[] };
  yAxis: { min: number; max: number; interval: number };
  series: Array<{
    name: string;
    type: string;
    stack: string;
    data: Array<{ name: string; value: number | null; displayValue: string }>;
    markPoint?: { data: Array<{ coord: number[]; label: { formatter: string } }> };
  }>;
  tooltip: { formatter: (params: Array<{ dataIndex: number }>) => string };
}
const charts = vi.hoisted((): ChartOption[] => []);
vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    option,
    empty,
    emptyMessage,
    loading,
  }: {
    option: ChartOption;
    empty?: boolean;
    emptyMessage?: string;
    loading?: boolean;
  }) => {
    if (option.series?.length) charts.push(option);
    return <div>{loading ? "Loading climbing chart" : empty ? emptyMessage : "Chart"}</div>;
  },
}));

import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart.tsx";
import { buildChartTable } from "./chart-accessibility.ts";

function chartOption() {
  const option = charts[0];
  if (!option) throw new Error("Grade progression chart not rendered");
  return option;
}
afterEach(() => {
  cleanup();
  charts.length = 0;
});

describe("ClimbingGradeProgressionChart", () => {
  it("renders mixed native grades in one timeline and one stack using server rates", () => {
    render(<ClimbingGradeProgressionChart data={climbingProgressionFixture()} />);
    expect(screen.getAllByText("Chart")).toHaveLength(1);
    for (const grade of ["V2", "V4", "5.9", "5.11a"]) expect(screen.getByText(grade)).toBeTruthy();
    const option = chartOption();
    expect(option.xAxis).toMatchObject({ show: true, data: ["Jun", "Jul", "Aug"] });
    expect(option.yAxis).toMatchObject({ min: 0, max: 6, interval: 2 });
    expect(option.series.map((series) => series.name)).toEqual(["V2", "V4", "5.9", "5.11a"]);
    expect(new Set(option.series.map((series) => series.stack)).size).toBe(1);
    expect(option.series[0]?.data.map((point) => point.value)).toEqual([1, 0, null]);
  });

  it("retains loading and empty states", () => {
    const { rerender } = render(<ClimbingGradeProgressionChart data={null} loading />);
    expect(screen.getByText("Loading climbing chart")).toBeTruthy();
    rerender(<ClimbingGradeProgressionChart data={null} />);
    expect(screen.getByText("No recorded climbing grades")).toBeTruthy();
  });

  it("exposes server counts and distinct recorded days in chart data and tooltips", () => {
    render(<ClimbingGradeProgressionChart data={climbingProgressionFixture()} />);
    const option = chartOption();
    expect(buildChartTable({ ...option }).rows).toContainEqual(
      expect.objectContaining({
        category: "Jun 2026",
        value: "1.0 sends/day · 5 sends · 5 recorded days",
      }),
    );
    const tooltip = option.tooltip.formatter([{ dataIndex: 0 }]);
    expect(tooltip).toContain("Jun 2026");
    expect(tooltip).toContain("4.0 sends/day · 20 sends · 5 recorded days");
    expect(tooltip).toContain("5.11a");
    expect(option.tooltip.formatter([{ dataIndex: 1 }])).toContain("1 outcome unrecorded");
    expect(option.tooltip.formatter([{ dataIndex: 2 }])).toContain("No recorded days");
    expect(option.tooltip.formatter([])).toBe("");
  });

  it("marks known zero sends differently from an unrecorded period", () => {
    render(<ClimbingGradeProgressionChart data={climbingProgressionFixture()} />);
    expect(chartOption().series.at(-1)?.markPoint?.data).toMatchObject([
      { coord: [1, 0], label: { formatter: "0" } },
      { coord: [2, 0], label: { formatter: "—" } },
    ]);
  });

  it("keeps retained grade scales identifiable and escapes grade labels in tooltips", () => {
    const data = climbingProgressionFixture();
    data.grades[0] = {
      key: "font",
      climbKind: "boulder",
      gradeSystem: "font",
      grade: "6A <test>",
      gradeSortValue: 60,
    };
    data.grades[1] = {
      key: "french",
      climbKind: "route",
      gradeSystem: "french",
      grade: "6A <test>",
      gradeSortValue: 60,
    };
    data.periods = data.periods.map((period) => ({
      ...period,
      segments: period.segments.map((segment, index) => ({
        ...segment,
        gradeKey: data.grades[index]?.key ?? segment.gradeKey,
      })),
    }));
    render(<ClimbingGradeProgressionChart data={data} />);
    expect(screen.getByText(/6A <test>.*Fontainebleau/)).toBeTruthy();
    expect(screen.getByText(/6A <test>.*French/)).toBeTruthy();
    expect(chartOption().tooltip.formatter([{ dataIndex: 0 }])).toContain("&lt;test&gt;");
  });
});
