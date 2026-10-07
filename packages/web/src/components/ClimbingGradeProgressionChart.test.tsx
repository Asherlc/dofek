// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { climbingProgressionFixture } from "./climbing-progression-test-helpers.ts";

interface ChartOption {
  xAxis: { show: boolean; data: string[] };
  yAxis: { min: number; max: number; interval: number };
  series: Array<{
    name: string;
    type: string;
    stack: string;
    itemStyle: { decal?: unknown };
    data: Array<{ name: string; value: number | null; displayValue: string }>;
    markPoint?: { data: Array<{ coord: number[]; label: { formatter: string } }> };
  }>;
  tooltip: { formatter: (params: Array<{ dataIndex: number }>) => string };
}
const charts = vi.hoisted(() => new Map<string, ChartOption>());
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
    if (option.series?.[0]) charts.set(option.series[0].name.split(" · ")[0] ?? "", option);
    return <div>{loading ? "Loading climbing chart" : empty ? emptyMessage : "Chart"}</div>;
  },
}));

import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart.tsx";
import { buildChartTable } from "./chart-accessibility.ts";

function boulderOption() {
  const option = charts.get("Bouldering");
  if (!option) throw new Error("Bouldering chart not rendered");
  return option;
}
afterEach(() => {
  cleanup();
  charts.clear();
});

describe("ClimbingGradeProgressionChart", () => {
  it("distinguishes retained grade scales in style and focus labels", () => {
    const french = climbingProgressionFixture("lead");
    french.gradeSystem = "french";
    french.grades = french.grades.map((grade, index) => ({
      ...grade,
      grade: index === 0 ? "5c" : "6c",
    }));
    french.periods = french.periods.map((period) => ({
      ...period,
      settings: period.settings.map((point) => ({
        ...point,
        segments: point.segments.map((segment, index) => ({
          ...segment,
          grade: index === 0 ? "5c" : "6c",
        })),
      })),
    }));
    render(<ClimbingGradeProgressionChart data={[climbingProgressionFixture("lead"), french]} />);
    expect(screen.getByRole("button", { name: "Focus Lead · French" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Focus Lead · Yosemite Decimal System" }),
    ).toBeTruthy();
  });
  it("retains loading and empty states", () => {
    const { rerender } = render(<ClimbingGradeProgressionChart data={[]} loading />);
    expect(screen.getByText("Loading climbing chart")).toBeTruthy();
    rerender(<ClimbingGradeProgressionChart data={[]} />);
    expect(screen.getByText("No recorded climbing grades")).toBeTruthy();
  });
  it("renders distinct style lanes with grade stacks and patterned outdoor bars on a common scale", () => {
    render(
      <ClimbingGradeProgressionChart
        data={[
          climbingProgressionFixture(),
          climbingProgressionFixture("top-rope"),
          climbingProgressionFixture("lead"),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Focus Bouldering" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focus Top rope" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focus Lead" })).toBeTruthy();
    const option = boulderOption();
    expect(option.xAxis).toMatchObject({ show: true, data: ["Jun", "Jul", "Aug"] });
    expect(option.yAxis).toMatchObject({ min: 0, max: 6, interval: 2 });
    expect(option.series.map((series) => [series.stack, series.type])).toEqual([
      ["indoor", "bar"],
      ["indoor", "bar"],
      ["outdoor", "bar"],
      ["outdoor", "bar"],
    ]);
    expect(option.series[2]?.itemStyle.decal).toBeTruthy();
    expect(option.series[1]?.data.map((point) => point.value)).toEqual([1, 3.5, null]);
    expect(option.series[2]?.data.map((point) => point.value)).toEqual([1, 0, null]);
  });
  it("uses the server's rates, counts, and recorded days in readable chart data and tooltips", () => {
    render(<ClimbingGradeProgressionChart data={[climbingProgressionFixture()]} />);
    const option = boulderOption();
    const table = buildChartTable({ ...option });
    expect(table.rows).toContainEqual(
      expect.objectContaining({
        category: "Jun 2026",
        value: "3.0 sends/day · 12 sends · 4 recorded days",
      }),
    );
    const tooltip = option.tooltip.formatter([{ dataIndex: 1 }]);
    expect(tooltip).toContain("Jul 2026");
    expect(tooltip).toContain("14 sends");
    expect(tooltip).toContain("4 recorded days");
    expect(tooltip).toContain("Outdoor");
    expect(tooltip).toContain("0.0 sends/day");
    expect(option.tooltip.formatter([{ dataIndex: 2 }])).toContain("No recorded days");
  });
  it("focuses a style, compares or isolates settings, and returns to the overview", () => {
    render(
      <ClimbingGradeProgressionChart
        data={[climbingProgressionFixture(), climbingProgressionFixture("lead")]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Focus Bouldering" }));
    expect(screen.queryByRole("button", { name: "Focus Lead" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Setting" }), {
      target: { value: "outdoor" },
    });
    expect(boulderOption().series.every((series) => series.stack === "outdoor")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "All styles" }));
    expect(screen.getByRole("button", { name: "Focus Lead" })).toBeTruthy();
    expect(boulderOption().series.map((series) => series.stack)).toContain("indoor");
  });

  it("marks a known zero differently from an unrecorded period", () => {
    render(<ClimbingGradeProgressionChart data={[climbingProgressionFixture()]} />);
    const outdoor = boulderOption().series.find(
      (series) => series.name === "Bouldering · Outdoor · V4",
    );
    expect(outdoor?.markPoint?.data).toMatchObject([
      { coord: [1, 0], label: { formatter: "0" } },
      { coord: [2, 0], label: { formatter: "—" } },
    ]);
  });
  it("preserves unknown categories and escapes returned grade labels", () => {
    const lane = climbingProgressionFixture("unknown");
    lane.settings = ["unknown"];
    lane.periods = lane.periods.map((period) => ({
      ...period,
      settings: period.settings.slice(0, 1).map((setting) => ({
        ...setting,
        setting: "unknown",
        unknownOutcomes: 1,
        segments: setting.segments.map((segment) => ({
          ...segment,
          grade: `${segment.grade} <test>`,
        })),
      })),
    }));
    render(<ClimbingGradeProgressionChart data={[lane]} />);
    expect(screen.getByRole("button", { name: "Focus Unknown style" })).toBeTruthy();
    expect(screen.getByText("Unknown setting")).toBeTruthy();
    const tooltip = charts.get("Unknown style")?.tooltip.formatter([{ dataIndex: 0 }]);
    expect(tooltip).toContain("&lt;test&gt;");
    expect(tooltip).toContain("1 outcome unrecorded");
  });
});
