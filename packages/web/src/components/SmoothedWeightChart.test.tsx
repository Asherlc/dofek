/** @vitest-environment jsdom */

import { textColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SmoothedWeightRow } from "../../../server/src/routers/body-analytics.ts";

let capturedOption: Record<string, unknown> | null = null;

vi.mock("echarts-for-react", () => ({
  default: ({
    option,
    style,
  }: {
    option: Record<string, unknown>;
    style: Record<string, unknown>;
  }) => {
    capturedOption = option;
    return (
      <div
        data-testid="echarts-mock"
        data-option={JSON.stringify(option, (_key, value) =>
          typeof value === "function" ? "[function]" : value,
        )}
        style={style satisfies React.CSSProperties}
      />
    );
  },
}));

vi.mock("./LoadingSkeleton.tsx", () => ({
  ChartLoadingSkeleton: ({ height }: { height: number }) => (
    <div data-testid="loading-skeleton" style={{ height }} />
  ),
}));

const { SmoothedWeightChart } = await import("./SmoothedWeightChart.tsx");

const sampleData: SmoothedWeightRow[] = [
  {
    date: "2026-03-01",
    rawWeight: 84.0,
    rawWeightStatus: { kind: "observed", label: "Observed" },
    smoothedWeight: 84.0,
    smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
    weeklyChange: null,
    interpolated: false,
  },
  {
    date: "2026-03-02",
    rawWeight: 83.8,
    rawWeightStatus: { kind: "observed", label: "Observed" },
    smoothedWeight: 83.98,
    smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
    weeklyChange: null,
    interpolated: false,
  },
  {
    date: "2026-03-03",
    rawWeight: 84.2,
    rawWeightStatus: { kind: "observed", label: "Observed" },
    smoothedWeight: 84.0,
    smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
    weeklyChange: null,
    interpolated: false,
  },
  {
    date: "2026-03-04",
    rawWeight: 83.7,
    rawWeightStatus: { kind: "observed", label: "Observed" },
    smoothedWeight: 83.97,
    smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
    weeklyChange: null,
    interpolated: false,
  },
  {
    date: "2026-03-05",
    rawWeight: 84.1,
    rawWeightStatus: { kind: "observed", label: "Observed" },
    smoothedWeight: 83.98,
    smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
    weeklyChange: null,
    interpolated: false,
  },
  {
    date: "2026-03-06",
    rawWeight: 83.9,
    rawWeightStatus: { kind: "observed", label: "Observed" },
    smoothedWeight: 83.97,
    smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
    weeklyChange: null,
    interpolated: false,
  },
  {
    date: "2026-03-07",
    rawWeight: 84.0,
    rawWeightStatus: { kind: "observed", label: "Observed" },
    smoothedWeight: 83.98,
    smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
    weeklyChange: null,
    interpolated: false,
  },
  {
    date: "2026-03-08",
    rawWeight: 83.6,
    rawWeightStatus: { kind: "observed", label: "Observed" },
    smoothedWeight: 83.94,
    smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
    weeklyChange: -0.06,
    interpolated: false,
  },
  {
    date: "2026-03-09",
    rawWeight: 83.5,
    rawWeightStatus: { kind: "observed", label: "Observed" },
    smoothedWeight: 83.9,
    smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
    weeklyChange: -0.08,
    interpolated: false,
  },
  {
    date: "2026-03-10",
    rawWeight: 83.4,
    rawWeightStatus: { kind: "observed", label: "Observed" },
    smoothedWeight: 83.85,
    smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
    weeklyChange: -0.15,
    interpolated: false,
  },
];

describe("SmoothedWeightChart", () => {
  it("renders chart with data", () => {
    render(<SmoothedWeightChart data={sampleData} />);
    expect(screen.getByTestId("echarts-mock")).toBeDefined();
  });

  it("shows the latest Trend Weight and scale reading", () => {
    render(<SmoothedWeightChart data={sampleData} />);

    expect(screen.getByText("Estimated Trend Weight")).toBeDefined();
    expect(screen.getByText("83.9 kg")).toBeDefined();
    expect(screen.getByText("Observed: 83.4 kg")).toBeDefined();
  });

  it("renders loading state", () => {
    render(<SmoothedWeightChart data={[]} loading={true} />);
    expect(screen.getByTestId("loading-skeleton")).toBeDefined();
  });

  it("renders empty state", () => {
    render(<SmoothedWeightChart data={[]} />);
    expect(screen.getByText("No weight data available")).toBeDefined();
  });

  it("shows headline rate from prediction when available", () => {
    render(
      <SmoothedWeightChart
        data={sampleData}
        prediction={{
          ratePerWeek: -0.3,
          rateConfidence: 0.92,
          impliedDailyCalories: -330,
          periodDeltas: { days7: null, days14: null, days30: null },
          goal: null,
          projectionLine: [],
        }}
      />,
    );
    expect(screen.getByText("-0.3 kg/week")).toBeDefined();
    expect(screen.queryByText("-0.15 kg/week")).toBeNull();
  });

  it("uses neutral text for weight-rate direction", () => {
    render(
      <SmoothedWeightChart
        data={sampleData}
        prediction={{
          ratePerWeek: -0.3,
          rateConfidence: 0.92,
          impliedDailyCalories: -330,
          periodDeltas: { days7: null, days14: null, days30: null },
          goal: null,
          projectionLine: [],
        }}
      />,
    );

    expect(screen.getByText("-0.3 kg/week").style.color).toBe(
      `rgb(${Number.parseInt(textColors.secondary.slice(1, 3), 16)}, ${Number.parseInt(textColors.secondary.slice(3, 5), 16)}, ${Number.parseInt(textColors.secondary.slice(5, 7), 16)})`,
    );
  });

  it("does not show headline rate when prediction is missing", () => {
    const { container } = render(<SmoothedWeightChart data={sampleData} />);
    expect(container.textContent).not.toMatch(/\/week/);
  });

  it("y-axis min rounds down floating-point values to nearest even integer", () => {
    render(<SmoothedWeightChart data={sampleData} />);
    expect(capturedOption).not.toBeNull();

    const yAxis = capturedOption?.yAxis;
    if (!Array.isArray(yAxis)) throw new Error("Expected yAxis to be an array");

    const weightAxis = yAxis[0];
    if (typeof weightAxis?.min !== "function") throw new Error("Expected min to be a function");

    // Floating-point value like what kg-to-lbs conversion produces
    expect(weightAxis.min({ min: 183.9999997, max: 195 })).toBe(182);
    expect(weightAxis.min({ min: 185.0, max: 195 })).toBe(184);
    expect(weightAxis.min({ min: 186.5, max: 195 })).toBe(186);
    expect(weightAxis.min({ min: 84.0, max: 90 })).toBe(84);
    expect(weightAxis.min({ min: 83.3, max: 90 })).toBe(82);
  });

  it("filters out interpolated points from scatter series", () => {
    const dataWithInterpolation: SmoothedWeightRow[] = [
      {
        date: "2026-03-01",
        rawWeight: 84.0,
        rawWeightStatus: { kind: "observed", label: "Observed" },
        smoothedWeight: 84.0,
        smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
        weeklyChange: null,
        interpolated: false,
      },
      {
        date: "2026-03-02",
        rawWeight: null,
        rawWeightStatus: null,
        smoothedWeight: 83.9,
        smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
        weeklyChange: null,
        interpolated: true,
      },
      {
        date: "2026-03-03",
        rawWeight: 83.8,
        rawWeightStatus: { kind: "observed", label: "Observed" },
        smoothedWeight: 83.89,
        smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
        weeklyChange: null,
        interpolated: false,
      },
    ];
    render(<SmoothedWeightChart data={dataWithInterpolation} />);
    expect(capturedOption).not.toBeNull();

    const series = z
      .array(z.object({ name: z.string(), data: z.array(z.unknown()) }))
      .parse(capturedOption?.series);
    const scatterSeries = series.find((s) => s.name === "Raw Weight");
    // Should only have 2 data points (interpolated point filtered out)
    expect(scatterSeries?.data).toHaveLength(2);
  });

  it("rounds converted chart weights to 1 decimal place", () => {
    render(
      <SmoothedWeightChart
        data={[
          {
            date: "2026-03-01",
            rawWeight: 72.36123,
            rawWeightStatus: { kind: "observed", label: "Observed" },
            smoothedWeight: 72.36091,
            smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
            weeklyChange: -15.51971,
            interpolated: false,
          },
        ]}
      />,
    );
    expect(capturedOption).not.toBeNull();

    const series = z
      .array(z.object({ name: z.string(), data: z.array(z.tuple([z.string(), z.number()])) }))
      .parse(capturedOption?.series);

    for (const chartSeries of series) {
      for (const dataPoint of chartSeries.data) {
        const decimals = String(dataPoint[1]).split(".")[1]?.length ?? 0;
        expect(decimals).toBeLessThanOrEqual(1);
      }
    }
  });

  it("renders goal markLine when prediction has goal", () => {
    render(
      <SmoothedWeightChart
        data={sampleData}
        prediction={{
          ratePerWeek: -0.3,
          rateConfidence: 0.92,
          impliedDailyCalories: -330,
          periodDeltas: { days7: -0.3, days14: -0.6, days30: null },
          goal: {
            goalWeightKg: 80,
            remainingKg: -3.85,
            estimatedDate: "2026-06-01",
            daysRemaining: 90,
          },
          projectionLine: [],
        }}
      />,
    );
    expect(capturedOption).not.toBeNull();

    const series = z
      .array(z.object({ name: z.string() }).passthrough())
      .parse(capturedOption?.series);
    const trendSeries = series.find((s) => s.name === "Trend Weight");
    expect(trendSeries).toBeDefined();
    expect("markLine" in (trendSeries ?? {})).toBe(true);
  });

  it("renders projection line as separate series", () => {
    render(
      <SmoothedWeightChart
        data={sampleData}
        prediction={{
          ratePerWeek: -0.3,
          rateConfidence: 0.92,
          impliedDailyCalories: -330,
          periodDeltas: { days7: -0.3, days14: -0.6, days30: null },
          goal: null,
          projectionLine: [
            { date: "2026-03-11", projectedWeight: 83.8 },
            { date: "2026-03-12", projectedWeight: 83.75 },
          ],
        }}
      />,
    );
    expect(capturedOption).not.toBeNull();

    const series = z.array(z.object({ name: z.string() })).parse(capturedOption?.series);
    const projectionSeries = series.find((s) => s.name === "Projection");
    expect(projectionSeries).toBeDefined();
  });
});
