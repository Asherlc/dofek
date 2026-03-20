/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import type { UnitSystem } from "../lib/units.ts";
import { ActivityComparisonChart } from "./ActivityComparisonChart.tsx";

let capturedOption: Record<string, unknown> | null = null;

vi.mock("echarts-for-react", () => ({
  default: (props: { option: Record<string, unknown> }) => {
    capturedOption = props.option;
    return <div data-testid="echarts" />;
  },
}));

function renderWithUnits(ui: ReactNode, unitSystem: UnitSystem = "metric") {
  capturedOption = null;
  return render(
    <UnitContext.Provider value={{ unitSystem, setUnitSystem: () => {} }}>
      {ui}
    </UnitContext.Provider>,
  );
}

function getYAxisName(): string {
  const yAxis = capturedOption?.yAxis;
  if (yAxis && typeof yAxis === "object" && "name" in yAxis) {
    return String(yAxis.name);
  }
  return "";
}

function getFirstSeriesData(): Array<[string, number]> {
  const series = capturedOption?.series;
  if (Array.isArray(series) && series[0] && "data" in series[0]) {
    return series[0].data;
  }
  return [];
}

const mockData = [
  {
    activityName: "Park Loop",
    instances: [
      {
        date: "2026-03-10",
        averagePaceMinPerKm: 5,
        durationMinutes: 25,
        avgHeartRate: 150,
        elevationGainMeters: 50,
      },
      {
        date: "2026-03-15",
        averagePaceMinPerKm: 4.8,
        durationMinutes: 24,
        avgHeartRate: 148,
        elevationGainMeters: 50,
      },
    ],
  },
];

describe("ActivityComparisonChart", () => {
  it("shows empty state when no data", () => {
    renderWithUnits(<ActivityComparisonChart data={[]} />);
    expect(screen.getByText(/No repeated routes found/)).toBeDefined();
  });

  it("shows loading state", () => {
    renderWithUnits(<ActivityComparisonChart data={[]} loading={true} />);
    expect(screen.getByText(/Loading activity comparison data/)).toBeDefined();
  });

  it("uses /km pace label for metric", () => {
    renderWithUnits(<ActivityComparisonChart data={mockData} />, "metric");
    expect(capturedOption).not.toBeNull();
    expect(getYAxisName()).toContain("/km");
  });

  it("uses /mi pace label for imperial", () => {
    renderWithUnits(<ActivityComparisonChart data={mockData} />, "imperial");
    expect(capturedOption).not.toBeNull();
    expect(getYAxisName()).toContain("/mi");
  });

  it("converts pace values to imperial in series data", () => {
    renderWithUnits(<ActivityComparisonChart data={mockData} />, "imperial");
    const data = getFirstSeriesData();
    const first = data[0];
    if (!first) throw new Error("Expected series data");
    expect(first[1]).toBeGreaterThan(400);
    expect(first[1]).toBeLessThan(500);
  });

  it("keeps pace values in metric unchanged", () => {
    renderWithUnits(<ActivityComparisonChart data={mockData} />, "metric");
    const data = getFirstSeriesData();
    const first = data[0];
    if (!first) throw new Error("Expected series data");
    expect(first[1]).toBe(300);
  });
});
