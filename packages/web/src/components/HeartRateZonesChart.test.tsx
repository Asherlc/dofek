/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HrZonesChart, PowerZonesChart, WeeklyHrZonesChart } from "./HeartRateZonesChart.tsx";

const capturedOptions: Array<Record<string, unknown>> = [];

vi.mock("echarts-for-react", () => ({
  default: (props: { option: Record<string, unknown> }) => {
    capturedOptions.push(props.option);
    return <div data-testid="echarts" />;
  },
}));

function getCategoryAxisData(opt: Record<string, unknown>): string[] {
  const yAxis = opt.yAxis;
  if (!yAxis || typeof yAxis !== "object") {
    return [];
  }

  const data = Reflect.get(yAxis, "data");
  return Array.isArray(data) ? data.map((label) => String(label)) : [];
}

function formatCategoryAxisLabel(opt: Record<string, unknown>, value: string): string {
  const yAxis = opt.yAxis;
  if (!yAxis || typeof yAxis !== "object") return "";
  const axisLabel = Reflect.get(yAxis, "axisLabel");
  if (!axisLabel || typeof axisLabel !== "object") return "";
  const formatter = Reflect.get(axisLabel, "formatter");
  if (typeof formatter !== "function") return "";
  return String(formatter(value));
}

function getSeries(opt: Record<string, unknown>): Array<Record<string, unknown>> {
  const series = opt.series;
  return Array.isArray(series)
    ? series.filter(
        (item): item is Record<string, unknown> => item != null && typeof item === "object",
      )
    : [];
}

describe("HeartRateZonesChart", () => {
  it("renders aligned primary zone labels with subordinate zone names", () => {
    capturedOptions.length = 0;

    render(
      <HrZonesChart
        loading={false}
        zones={[
          { zone: 0, label: "Below Zone 1", minPct: 0, maxPct: 50, seconds: 150, percent: 14.3 },
          { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 300, percent: 28.6 },
          { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 600, percent: 57.1 },
        ]}
      />,
    );

    const option = capturedOptions[0];
    expect(option).toBeDefined();
    if (!option) throw new Error("Expected chart option");

    expect(getCategoryAxisData(option)).toEqual(["Below Zone 1", "Zone 1", "Zone 2"]);
    expect(formatCategoryAxisLabel(option, "Zone 1")).toBe("{zone|Zone 1}\n{name|Recovery}");
    expect(formatCategoryAxisLabel(option, "Zone 2")).toBe("{zone|Zone 2}\n{name|Aerobic}");
  });

  it("renders weekly heart-rate zones with shared readable zone labels", () => {
    capturedOptions.length = 0;

    render(
      <WeeklyHrZonesChart
        maxHr={190}
        weeks={[
          {
            week: "2026-05-18",
            zone0: 60,
            zone1: 120,
            zone2: 180,
            zone3: 90,
            zone4: 30,
            zone5: 0,
          },
        ]}
      />,
    );

    expect(screen.getByText(/Heart Rate Zone Distribution/)).toBeDefined();
    expect(screen.getByText("(max heart rate: 190 bpm)")).toBeDefined();
    const option = capturedOptions[0];
    expect(option).toBeDefined();
    if (!option) throw new Error("Expected chart option");

    const seriesNames = getSeries(option).map((seriesItem) => String(seriesItem.name));
    expect(seriesNames).toContain("Zone 1 Recovery");
    expect(seriesNames).toContain("Zone 2 Aerobic");
    expect(seriesNames).not.toContain("Z1 Recovery");
  });

  it("renders loading, error, and empty distribution states before chart data is available", () => {
    const { rerender } = render(<HrZonesChart loading zones={[]} />);
    expect(screen.getByTestId("chart-loading-skeleton")).toBeTruthy();

    rerender(
      <HrZonesChart errorMessage="Heart rate zones are unavailable." loading={false} zones={[]} />,
    );
    expect(screen.getByText("Heart rate zones are unavailable.")).toBeTruthy();

    rerender(<HrZonesChart loading={false} zones={[]} />);
    expect(screen.getByText("No heart rate zone data")).toBeTruthy();
  });

  it("renders power-zone distributions and a zero-duration weekly fallback", () => {
    capturedOptions.length = 0;
    const { rerender } = render(
      <PowerZonesChart
        ftp={250}
        loading={false}
        zones={[
          { zone: 1, label: "Endurance", minPct: 56, maxPct: 75, seconds: 300, percent: 100 },
        ]}
      />,
    );
    expect(getCategoryAxisData(capturedOptions[0] ?? {})).toEqual(["Zone 1"]);

    rerender(
      <WeeklyHrZonesChart
        maxHr={null}
        weeks={[{ week: "2026-05-25", zone0: 0, zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 }]}
      />,
    );
    expect(screen.queryByText(/max heart rate:/)).toBeNull();
    const option = capturedOptions[1];
    if (!option) throw new Error("Expected weekly zone chart option");
    const series = getSeries(option);
    expect(series.every((seriesItem) => JSON.stringify(seriesItem.data).includes(",0]"))).toBe(
      true,
    );
  });
});
