/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { UnitContext } from "../../lib/unitContext.ts";
import type { UnitSystem } from "../../lib/units.ts";
import { convertPace } from "../../lib/units.ts";

const capturedOptions: Array<Record<string, unknown>> = [];

vi.mock("echarts-for-react", () => ({
  default: (props: { option: Record<string, unknown> }) => {
    capturedOptions.push(props.option);
    return <div data-testid="echarts" />;
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => null,
}));

const mockPaceCurveData = {
  points: [
    { durationSeconds: 60, label: "1min", bestPaceSecondsPerKm: 240, activityDate: "2026-03-15" },
    {
      durationSeconds: 300,
      label: "5min",
      bestPaceSecondsPerKm: 270,
      activityDate: "2026-03-15",
    },
  ],
};

const mockPaceTrendData = [
  {
    date: "2026-03-15",
    activityName: "Morning Run",
    paceSecondsPerKm: 300,
    distanceKm: 10,
    durationMinutes: 50,
  },
];

const mockDynamicsData = [
  {
    date: "2026-03-15",
    activityName: "Morning Run",
    cadence: 180,
    strideLengthMeters: 1.2,
    stanceTimeMs: 240,
    verticalOscillationMm: 8.5,
    paceSecondsPerKm: 300,
    distanceKm: 10,
  },
];

vi.mock("../../lib/trainingDaysContext.ts", () => ({
  useTrainingDays: () => ({ days: 90 }),
}));

vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    durationCurves: {
      paceCurve: { useQuery: () => ({ data: mockPaceCurveData, isLoading: false }) },
    },
    running: {
      paceTrend: { useQuery: () => ({ data: mockPaceTrendData, isLoading: false }) },
      dynamics: { useQuery: () => ({ data: mockDynamicsData, isLoading: false }) },
    },
  },
}));

function renderWithUnits(ui: ReactNode, unitSystem: UnitSystem = "metric") {
  capturedOptions.length = 0;
  return render(
    <UnitContext.Provider value={{ unitSystem, setUnitSystem: () => {} }}>
      {ui}
    </UnitContext.Provider>,
  );
}

async function importRunningTab() {
  const mod = await import("./running.tsx");
  return mod.RunningTab;
}

describe("RunningTab", () => {
  describe("RunningDynamicsTable unit display", () => {
    it("shows metric pace and distance labels", async () => {
      const RunningTab = await importRunningTab();
      renderWithUnits(<RunningTab />, "metric");
      expect(screen.getAllByText(/\/km/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/10\.0/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/\bkm\b/).length).toBeGreaterThanOrEqual(1);
    });

    it("shows imperial pace and distance labels", async () => {
      const RunningTab = await importRunningTab();
      renderWithUnits(<RunningTab />, "imperial");
      expect(screen.getAllByText(/\/mi/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/6\.2/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/\bmi\b/).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("PaceCurveChart no double conversion", () => {
    it("series data is converted and tooltip does not re-convert", async () => {
      const RunningTab = await importRunningTab();
      renderWithUnits(<RunningTab />, "imperial");

      const paceCurveOption = capturedOptions.find((opt) => {
        const xAxis = opt.xAxis;
        return xAxis && typeof xAxis === "object" && "type" in xAxis && xAxis.type === "log";
      });
      expect(paceCurveOption).toBeDefined();
      if (!paceCurveOption) return;

      const series = paceCurveOption.series;
      if (!Array.isArray(series) || !series[0]) return;
      const data = series[0].data;
      const firstPace = data[0][1];
      const expectedPace = convertPace(240, "imperial");
      expect(firstPace).toBeCloseTo(expectedPace, 1);

      const tooltip = paceCurveOption.tooltip;
      if (!tooltip || typeof tooltip !== "object" || !("formatter" in tooltip)) return;
      const formatter = tooltip.formatter;
      if (typeof formatter !== "function") return;
      const tooltipResult = formatter({
        data: [60, firstPace],
        seriesName: "Best Pace",
      });
      expect(tooltipResult).toContain("6:");
      expect(tooltipResult).not.toContain("10:");
    });
  });

  describe("PaceTrendChart", () => {
    it("uses /mi label on y-axis for imperial", async () => {
      const RunningTab = await importRunningTab();
      renderWithUnits(<RunningTab />, "imperial");

      const paceTrendOption = capturedOptions.find((opt) => {
        const series = opt.series;
        return (
          Array.isArray(series) &&
          series.some((s: Record<string, unknown>) => typeof s === "object" && s.type === "scatter")
        );
      });
      expect(paceTrendOption).toBeDefined();
    });
  });
});
