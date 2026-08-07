/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("echarts-for-react", () => ({
  default: ({
    option,
    style,
  }: {
    option: Record<string, unknown>;
    style: Record<string, unknown>;
  }) => (
    <div
      data-testid="echarts-mock"
      data-option={JSON.stringify(option)}
      style={style satisfies React.CSSProperties}
    />
  ),
}));

vi.mock("./LoadingSkeleton.tsx", () => ({
  ChartLoadingSkeleton: ({ height }: { height: number }) => (
    <div data-testid="loading-skeleton" style={{ height }} />
  ),
}));

const { AerobicEfficiencyChart } = await import("./AerobicEfficiencyChart.tsx");
const { chartThemeColors } = await import("../lib/chartTheme.ts");

const chartSeriesSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  data: z.array(z.tuple([z.string(), z.number()])).optional(),
});

const chartOptionSchema = z.object({
  series: z.array(chartSeriesSchema),
  xAxis: z.object({
    type: z.string(),
    show: z.boolean(),
    name: z.string(),
    axisLine: z.object({
      show: z.boolean(),
      lineStyle: z.object({
        color: z.string(),
      }),
    }),
    axisTick: z.object({
      show: z.boolean(),
    }),
  }),
});

function parseChartOption(chartElement: HTMLElement) {
  const option: unknown = JSON.parse(chartElement.dataset.option ?? "{}");
  return chartOptionSchema.parse(option);
}

describe("AerobicEfficiencyChart", () => {
  it("renders empty state without crashing when activities is empty", () => {
    // This was the bug: empty activities caused new Date(Infinity).toISOString()
    // to throw RangeError: Invalid time value
    expect(() => {
      render(<AerobicEfficiencyChart activities={[]} maxHr={null} />);
    }).not.toThrow();

    expect(
      screen.getByText("No activities with sufficient Zone 2 power + heart rate data"),
    ).toBeDefined();
  });

  it("renders loading state", () => {
    render(<AerobicEfficiencyChart activities={[]} maxHr={null} loading={true} />);
    expect(screen.getByTestId("loading-skeleton")).toBeDefined();
  });

  it("renders power and heart rate lines when activities are provided", () => {
    const activities = [
      {
        date: "2026-03-10",
        activityType: "cycling",
        name: "Morning Ride",
        avgPowerZ2: 180,
        avgHrZ2: 135,
        efficiencyFactor: 1.333,
        z2Samples: 600,
      },
      {
        date: "2026-03-15",
        activityType: "cycling",
        name: "Evening Ride",
        avgPowerZ2: 185,
        avgHrZ2: 133,
        efficiencyFactor: 1.391,
        z2Samples: 900,
      },
    ];

    render(<AerobicEfficiencyChart activities={activities} maxHr={190} />);
    const chartElement = screen.getByTestId("echarts-mock");
    const option = parseChartOption(chartElement);

    expect(option.series.map((series) => series.name)).toEqual(["Power", "Heart Rate"]);
    expect(option.series.every((series) => series.type === "line")).toBe(true);
    const powerSeries = option.series.find((series) => series.name === "Power");
    const heartRateSeries = option.series.find((series) => series.name === "Heart Rate");
    expect(powerSeries?.data).toEqual([
      ["2026-03-10", 180],
      ["2026-03-15", 185],
    ]);
    expect(heartRateSeries?.data).toEqual([
      ["2026-03-10", 135],
      ["2026-03-15", 133],
    ]);
  });

  it("shows a visible date x-axis", () => {
    const activities = [
      {
        date: "2026-03-10",
        activityType: "cycling",
        name: "Morning Ride",
        avgPowerZ2: 180,
        avgHrZ2: 135,
        efficiencyFactor: 1.333,
        z2Samples: 600,
      },
    ];

    render(<AerobicEfficiencyChart activities={activities} maxHr={190} />);
    const chartElement = screen.getByTestId("echarts-mock");
    const option = parseChartOption(chartElement);

    expect(option.xAxis.type).toBe("time");
    expect(option.xAxis.show).toBe(true);
    expect(option.xAxis.name).toBe("Date");
    expect(option.xAxis.axisLine.show).toBe(true);
    expect(option.xAxis.axisLine.lineStyle.color).toBe(chartThemeColors.axisLine);
    expect(option.xAxis.axisTick.show).toBe(true);
  });

  it("uses original date strings for line points to avoid timezone drift", () => {
    const activities = [
      {
        date: "2026-03-10",
        activityType: "cycling",
        name: "Morning Ride",
        avgPowerZ2: 180,
        avgHrZ2: 135,
        efficiencyFactor: 1.333,
        z2Samples: 600,
      },
      {
        date: "2026-03-15",
        activityType: "cycling",
        name: "Evening Ride",
        avgPowerZ2: 185,
        avgHrZ2: 133,
        efficiencyFactor: 1.391,
        z2Samples: 900,
      },
    ];

    render(<AerobicEfficiencyChart activities={activities} maxHr={190} />);
    const chartElement = screen.getByTestId("echarts-mock");
    const option = parseChartOption(chartElement);

    expect(option.series).toBeDefined();
    expect(Array.isArray(option.series)).toBe(true);
    expect(option.series.length).toBeGreaterThanOrEqual(2);
    const powerSeries = option.series.find((series) => series.name === "Power");

    expect(powerSeries).toBeDefined();
    expect(Array.isArray(powerSeries?.data)).toBe(true);
    expect(powerSeries?.data?.length).toBeGreaterThanOrEqual(2);
    expect(powerSeries?.data?.[0]?.[0]).toBe("2026-03-10");
    expect(powerSeries?.data?.[1]?.[0]).toBe("2026-03-15");
  });

  it("does not show Invalid Date in rendered output", () => {
    render(<AerobicEfficiencyChart activities={[]} maxHr={null} />);
    expect(screen.queryByText("Invalid Date")).toBeNull();
  });
});
