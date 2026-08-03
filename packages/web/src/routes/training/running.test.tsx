/** @vitest-environment jsdom */

import type { UnitSystem } from "@dofek/format/units";
import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TrainingChartAvailability } from "dofek-server/types";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnitContext } from "../../lib/unitContext.ts";

const capturedOptions: Array<Record<string, unknown>> = [];
const state = vi.hoisted<{
  queryCalls: Array<{ name: string; input: unknown }>;
  selectedDays: number | null;
}>(() => ({
  queryCalls: [],
  selectedDays: 90,
}));

vi.mock("echarts-for-react", () => ({
  default: (props: { option: Record<string, unknown> }) => {
    capturedOptions.push(props.option);
    return <div data-testid="echarts" />;
  },
}));

const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => null,
  useNavigate: () => mockNavigate,
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
  availability: {
    status: "available" as const,
    sourceLabel: "Running pace duration-curve read model",
    observedCount: 2,
    minimumCount: 1,
    message: "Running pace duration data is available.",
  },
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
    activityId: "activity-1",
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

const mockPaceTrendResponse = {
  data: mockPaceTrendData,
  availability: {
    status: "available" as const,
    sourceLabel: "Running activity sensor summaries",
    observedCount: 1,
    minimumCount: 1,
    message: "Running pace data is available.",
  },
};

const mockDynamicsResponse = {
  data: mockDynamicsData,
  availability: {
    status: "available" as const,
    sourceLabel: "Running activity sensor summaries",
    observedCount: 1,
    minimumCount: 1,
    message: "Running dynamics data is available.",
  },
};

interface QueryResult<Data> {
  data: Data;
  isLoading: boolean;
  error: Error | null;
}

type PaceCurveResponse = {
  points: typeof mockPaceCurveData.points;
  availability: TrainingChartAvailability;
};
type ChartResponse<Data> = {
  data: Data;
  availability: TrainingChartAvailability;
};

let paceCurveQuery: QueryResult<PaceCurveResponse> = {
  data: mockPaceCurveData,
  isLoading: false,
  error: null,
};
let paceTrendQuery: QueryResult<ChartResponse<typeof mockPaceTrendData>> = {
  data: mockPaceTrendResponse,
  isLoading: false,
  error: null,
};
let dynamicsQuery: QueryResult<ChartResponse<typeof mockDynamicsData>> = {
  data: mockDynamicsResponse,
  isLoading: false,
  error: null,
};

vi.mock("../../lib/trainingDaysContext.ts", () => ({
  useTrainingDays: () => ({ days: state.selectedDays }),
}));

vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      activity: {
        list: { invalidate: vi.fn() },
      },
    }),
    durationCurves: {
      paceCurve: {
        useQuery: (input: unknown) => {
          state.queryCalls.push({ name: "paceCurve", input });
          return paceCurveQuery;
        },
      },
    },
    running: {
      paceTrendV2: {
        useQuery: (input: unknown) => {
          state.queryCalls.push({ name: "paceTrendV2", input });
          return paceTrendQuery;
        },
      },
      dynamicsV2: {
        useQuery: (input: unknown) => {
          state.queryCalls.push({ name: "dynamicsV2", input });
          return dynamicsQuery;
        },
      },
    },
    activity: {
      list: { useQuery: () => ({ data: { items: [], totalCount: 0 }, isLoading: false }) },
      bulkDelete: {
        useMutation: () => ({
          mutateAsync: vi.fn(),
          isPending: false,
          error: null,
        }),
      },
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
  beforeEach(() => {
    mockNavigate.mockReset();
    state.queryCalls.length = 0;
    state.selectedDays = 90;
    paceCurveQuery = { data: mockPaceCurveData, isLoading: false, error: null };
    paceTrendQuery = { data: mockPaceTrendResponse, isLoading: false, error: null };
    dynamicsQuery = { data: mockDynamicsResponse, isLoading: false, error: null };
  });

  afterEach(() => {
    cleanup();
  });

  describe("selected range queries", () => {
    it("uses the selected finite days for every chart query", async () => {
      state.selectedDays = 30;

      const RunningTab = await importRunningTab();
      renderWithUnits(<RunningTab />);

      expect(state.queryCalls).toEqual([
        { name: "paceCurve", input: { days: 30 } },
        { name: "paceTrendV2", input: { days: 30 } },
        { name: "dynamicsV2", input: { days: 30 } },
      ]);
    });

    it("passes null for All to every selected-range chart query", async () => {
      state.selectedDays = null;

      const RunningTab = await importRunningTab();
      renderWithUnits(<RunningTab />);

      expect(state.queryCalls).toEqual([
        { name: "paceCurve", input: { days: null } },
        { name: "paceTrendV2", input: { days: null } },
        { name: "dynamicsV2", input: { days: null } },
      ]);
    });
  });

  describe("RunningDynamicsTable unit display", () => {
    it("navigates to activity detail on row click", async () => {
      const RunningTab = await importRunningTab();
      renderWithUnits(<RunningTab />);

      const row = screen.getByText("Morning Run").closest("tr");
      if (!row) throw new Error("Row not found");
      fireEvent.click(row);

      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/activity/$id",
        params: { id: "activity-1" },
      });
    });

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
      const expectedPace = new UnitConverter("imperial").convertPace(240);
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

  describe("background refetch errors", () => {
    it("keeps cached running data visible when queries have data and an error", async () => {
      const backgroundError = new Error("Transient refetch failure");
      paceCurveQuery = { data: mockPaceCurveData, isLoading: false, error: backgroundError };
      paceTrendQuery = { data: mockPaceTrendResponse, isLoading: false, error: backgroundError };
      dynamicsQuery = { data: mockDynamicsResponse, isLoading: false, error: backgroundError };

      const RunningTab = await importRunningTab();
      renderWithUnits(<RunningTab />);

      expect(screen.queryByText("Transient refetch failure")).toBeNull();
      expect(screen.getAllByText("Morning Run").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByTestId("echarts").length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("insufficient chart data", () => {
    it("renders compact empty states for every running chart and table", async () => {
      paceCurveQuery = {
        data: {
          points: [],
          availability: {
            status: "insufficient_data",
            sourceLabel: "Running pace duration-curve read model",
            observedCount: 0,
            minimumCount: 1,
            message: "Pace curve data is unavailable.",
          },
        },
        isLoading: false,
        error: null,
      };
      paceTrendQuery = {
        data: {
          data: [],
          availability: {
            status: "insufficient_data",
            sourceLabel: "Running activity sensor summaries",
            observedCount: 0,
            minimumCount: 1,
            message: "Pace trend data is unavailable.",
          },
        },
        isLoading: false,
        error: null,
      };
      dynamicsQuery = {
        data: {
          data: [],
          availability: {
            status: "insufficient_data",
            sourceLabel: "Running activity sensor summaries",
            observedCount: 0,
            minimumCount: 1,
            message: "Running dynamics data is unavailable.",
          },
        },
        isLoading: false,
        error: null,
      };

      const RunningTab = await importRunningTab();
      renderWithUnits(<RunningTab />);

      expect(screen.getByText("Pace curve data is unavailable.")).toBeTruthy();
      expect(screen.getByText("Pace trend data is unavailable.")).toBeTruthy();
      expect(screen.getAllByText("Running dynamics data is unavailable.")).toHaveLength(2);
      expect(screen.getAllByTestId("training-chart-empty-state")).toHaveLength(4);
      expect(screen.queryAllByTestId("echarts")).toHaveLength(0);
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
