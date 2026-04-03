/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

const sampleData = [
  { date: "2026-03-01", rawWeight: 84.0, smoothedWeight: 84.0, weeklyChange: null },
  { date: "2026-03-02", rawWeight: 83.8, smoothedWeight: 83.98, weeklyChange: null },
  { date: "2026-03-03", rawWeight: 84.2, smoothedWeight: 84.0, weeklyChange: null },
  { date: "2026-03-04", rawWeight: 83.7, smoothedWeight: 83.97, weeklyChange: null },
  { date: "2026-03-05", rawWeight: 84.1, smoothedWeight: 83.98, weeklyChange: null },
  { date: "2026-03-06", rawWeight: 83.9, smoothedWeight: 83.97, weeklyChange: null },
  { date: "2026-03-07", rawWeight: 84.0, smoothedWeight: 83.98, weeklyChange: null },
  { date: "2026-03-08", rawWeight: 83.6, smoothedWeight: 83.94, weeklyChange: -0.06 },
  { date: "2026-03-09", rawWeight: 83.5, smoothedWeight: 83.9, weeklyChange: -0.08 },
  { date: "2026-03-10", rawWeight: 83.4, smoothedWeight: 83.85, weeklyChange: -0.15 },
];

describe("SmoothedWeightChart", () => {
  it("renders chart with data", () => {
    render(<SmoothedWeightChart data={sampleData} />);
    expect(screen.getByTestId("echarts-mock")).toBeDefined();
  });

  it("renders loading state", () => {
    render(<SmoothedWeightChart data={[]} loading={true} />);
    expect(screen.getByTestId("loading-skeleton")).toBeDefined();
  });

  it("renders empty state", () => {
    render(<SmoothedWeightChart data={[]} />);
    expect(screen.getByText("No weight data available")).toBeDefined();
  });

  it("shows weekly change when available", () => {
    render(<SmoothedWeightChart data={sampleData} />);
    expect(screen.getByText(/\/week/)).toBeDefined();
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
});
