// @vitest-environment jsdom
import { gradeSortValue } from "@dofek/training/climbing-grades";
import { cleanup, render, screen } from "@testing-library/react";
import type { ClimbingGradeProgressionRow } from "dofek-server/types";
import { afterEach, describe, expect, it, vi } from "vitest";

interface ChartOption {
  grid: { left: number; right: number };
  xAxis: { axisLabel: { formatter: (value: number) => string } };
  yAxis: Array<{
    show: boolean;
    position: string;
    min: number;
    max: number;
    axisLabel: { customValues: number[]; formatter: (value: number) => string };
    axisTick: { customValues: number[] };
    splitLine: { show?: boolean };
  }>;
  series: Array<{
    name: string;
    smooth: boolean;
    data: Array<{ name: string; value: [number, number] }>;
  }>;
  tooltip: { formatter: (params: Array<{ seriesIndex: number; dataIndex: number }>) => string };
}

const chart = vi.hoisted((): { option: ChartOption | undefined; loading: boolean } => ({
  option: undefined,
  loading: false,
}));
vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    empty,
    emptyMessage,
    option,
    loading,
  }: {
    empty?: boolean;
    emptyMessage?: string;
    option: ChartOption;
    loading?: boolean;
  }) => {
    chart.option = option;
    chart.loading = loading ?? false;
    return <div data-testid="chart">{empty ? emptyMessage : "Chart"}</div>;
  },
}));

import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart.tsx";
import { buildChartTable } from "./chart-accessibility.ts";

function row(
  date: string,
  climbType: ClimbingGradeProgressionRow["climbType"],
  grade: string,
  gradeSystem: ClimbingGradeProgressionRow["gradeSystem"] = climbType === "boulder"
    ? "v_scale"
    : "yds",
): ClimbingGradeProgressionRow {
  const score = gradeSortValue(grade, gradeSystem);
  if (score === null) throw new Error(`Invalid fixture grade: ${grade}`);
  return { date, climbType, grade, gradeSystem, gradeSortValue: score };
}

function option(): ChartOption {
  if (!chart.option) throw new Error("Chart was not rendered");
  return chart.option;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ClimbingGradeProgressionChart", () => {
  it("retains loading and empty states", () => {
    render(<ClimbingGradeProgressionChart data={[]} loading />);
    expect(chart.loading).toBe(true);
    expect(screen.getByText("No climbing grade progression")).toBeTruthy();
  });

  it("shows a readable session date in the chart data table", () => {
    render(<ClimbingGradeProgressionChart data={[row("2026-07-01", "boulder", "V4")]} />);
    expect(buildChartTable({ ...option() }).rows[0]?.category).toBe("Jul 1, 2026");
    expect(buildChartTable({ ...option() }).rows[0]?.value).toBe("V4");
  });

  it("aligns plotted dates with local selected-range boundaries", () => {
    const firstBoundary = new Date(2026, 6, 1);
    const lastBoundary = new Date(2026, 6, 29);
    render(
      <ClimbingGradeProgressionChart
        data={[row("2026-07-01", "boulder", "V2"), row("2026-07-29", "boulder", "V4")]}
      />,
    );
    expect(option().series[0]?.data.map((datum) => datum.value[0])).toEqual([
      firstBoundary.getTime(),
      lastBoundary.getTime(),
    ]);
  });

  it("sorts each series chronologically, draws straight lines, and keeps newest summaries", () => {
    render(
      <ClimbingGradeProgressionChart
        data={[
          row("2026-07-10", "boulder", "V4"),
          row("2026-07-11", "route", "5.10a"),
          row("2026-07-01", "boulder", "V2"),
          row("2026-07-02", "route", "5.11a"),
        ]}
      />,
    );
    expect(option().series[0]?.data.map((datum) => datum.value)).toEqual([
      [new Date(2026, 6, 1).getTime(), 55],
      [new Date(2026, 6, 10).getTime(), 65],
    ]);
    expect(option().series.every((series) => series.smooth === false)).toBe(true);
    expect(screen.getByText("V4")).toBeTruthy();
    expect(screen.getByText("5.10a")).toBeTruthy();
    expect(screen.queryByText("V2")).toBeNull();
  });

  it("uses actual grade ticks on separate left and right axes with one grid-line set", () => {
    render(
      <ClimbingGradeProgressionChart
        data={[
          row("2026-07-01", "boulder", "V2"),
          row("2026-07-08", "boulder", "V4"),
          row("2026-07-01", "route", "5.10a"),
          row("2026-07-08", "route", "5.11a"),
        ]}
      />,
    );
    const [boulder, route] = option().yAxis;
    expect(boulder?.position).toBe("left");
    expect(route?.position).toBe("right");
    expect(route?.splitLine.show).toBe(false);
    expect(option().grid.left).toBeGreaterThanOrEqual(64);
    expect(option().grid.right).toBeGreaterThanOrEqual(64);
    for (const axis of option().yAxis) {
      expect(axis.axisTick.customValues).toEqual(axis.axisLabel.customValues);
      for (const score of axis.axisLabel.customValues) {
        const grade = axis.axisLabel.formatter(score);
        expect(grade).not.toBe("");
        expect(gradeSortValue(grade, axis === boulder ? "v_scale" : "yds")).toBe(score);
      }
      expect(axis.axisLabel.formatter(63.123)).toBe("");
    }
  });

  it.each(["boulder", "route"] as const)("shows a sensible single %s axis", (climbType) => {
    render(
      <ClimbingGradeProgressionChart
        data={[row("2026-07-01", climbType, climbType === "boulder" ? "V4" : "5.10a")]}
      />,
    );
    const visible = option().yAxis.filter((axis) => axis.show);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.position).toBe("left");
    expect(visible[0]?.splitLine.show).not.toBe(false);
    expect(visible[0]?.min).toBeLessThan(visible[0]?.max ?? 0);
  });

  it("uses the returned display system and original grade in the tooltip", () => {
    const point = row("2026-07-01", "route", "6a+", "french");
    render(<ClimbingGradeProgressionChart data={[{ ...point, grade: "6a+ <test>" }]} />);
    expect(option().yAxis[1]?.axisLabel.formatter(62.5)).toBe("6a+");
    const tooltip = option().tooltip.formatter([{ seriesIndex: 1, dataIndex: 0 }]);
    expect(tooltip).toContain("Route: <strong>6a+ &lt;test&gt;</strong>");
    expect(tooltip).not.toContain("62.5");
    expect(tooltip).not.toContain("00:00");
  });

  it.each([
    ["en-US", "America/Los_Angeles", "-07:00", "Jul 1", "Jul 1, 2026"],
    ["en-US", "Pacific/Kiritimati", "+14:00", "Jul 1", "Jul 1, 2026"],
    ["de-DE", "America/Los_Angeles", "-07:00", "1. Juli", "1. Juli 2026"],
    ["de-DE", "Pacific/Kiritimati", "+14:00", "1. Juli", "1. Juli 2026"],
  ])(
    "preserves calendar dates in viewer locale %s and time zone %s",
    async (locale, zone, offset, shortDate, mediumDate) => {
      vi.resetModules();
      const DateTimeFormat = Intl.DateTimeFormat;
      vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
        function DeviceDateTimeFormat(locales, options) {
          return new DateTimeFormat(locales ?? locale, {
            ...options,
            timeZone: options?.timeZone ?? zone,
          });
        },
      );
      const { ClimbingGradeProgressionChart: LocalizedChart } = await import(
        "./ClimbingGradeProgressionChart.tsx"
      );
      render(<LocalizedChart data={[row("2026-07-01", "boulder", "V4")]} />);
      const localMidnight = Date.parse(`2026-07-01T00:00:00${offset}`);
      expect(option().xAxis.axisLabel.formatter(localMidnight)).toBe(shortDate);
      const tooltip = option().tooltip.formatter([{ seriesIndex: 0, dataIndex: 0 }]);
      expect(tooltip).toContain(mediumDate);
      expect(buildChartTable({ ...option() }).rows[0]?.category).toBe(mediumDate);
      expect(tooltip).not.toContain("Jun");
      expect(tooltip).not.toContain("00:00");
    },
  );
});
