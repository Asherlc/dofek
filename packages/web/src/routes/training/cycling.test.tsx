/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted<{
  capturedRouteComponents: Record<string, ComponentType>;
  outletComponent: ComponentType | null;
  efficiencyActivities: Array<{
    date: string;
    activityType: string;
    name: string;
    avgPowerZ2: number;
    avgHrZ2: number;
    efficiencyFactor: number;
    z2Samples: number;
  }>;
  capturedAerobicEfficiencyActivities: unknown[] | null;
  performanceHasData: boolean;
  timeToExhaustionAvailable: boolean;
  performanceError: Error | null;
  activityAnalyticsHasData: boolean;
  activityAnalyticsError: Error | null;
  bulkDeleteOnSuccess: (() => Promise<void>) | null;
  invalidatedQueries: string[];
  queryCalls: Array<{ name: string; input: unknown }>;
  selectedDays: number | null;
}>(() => ({
  capturedRouteComponents: {},
  outletComponent: null,
  efficiencyActivities: [],
  capturedAerobicEfficiencyActivities: null,
  performanceHasData: true,
  timeToExhaustionAvailable: true,
  performanceError: null,
  activityAnalyticsHasData: true,
  activityAnalyticsError: null,
  bulkDeleteOnSuccess: null,
  invalidatedQueries: [],
  queryCalls: [],
  selectedDays: 90,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (path: string) => (config: { component: ComponentType }) => {
    state.capturedRouteComponents[path] = config.component;
    return {};
  },
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  Outlet: () => (state.outletComponent ? <state.outletComponent /> : null),
}));

vi.mock("@dofek/training/training", () => ({
  CYCLING_ACTIVITY_TYPES: ["cycling"],
}));
vi.mock("../../components/ActivityVariabilityTable.tsx", () => ({
  ActivityVariabilityTable: ({
    offset,
    limit,
    onPageChange,
  }: {
    offset: number;
    limit: number;
    onPageChange: (offset: number) => void;
  }) => (
    <button type="button" onClick={() => onPageChange(offset + limit)}>
      Next variability page
    </button>
  ),
}));
vi.mock("../../components/ActivityList.tsx", () => ({
  ActivityList: ({
    error,
    page,
    onPageChange,
  }: {
    error?: string;
    page: number;
    onPageChange: (page: number) => void;
  }) => (
    <>
      {error ? <p>{error}</p> : null}
      <button type="button" onClick={() => onPageChange(page + 1)}>
        Next activity page
      </button>
    </>
  ),
}));
vi.mock("../../components/AerobicEfficiencyChart.tsx", () => ({
  AerobicEfficiencyChart: ({ activities }: { activities: unknown[] }) => {
    state.capturedAerobicEfficiencyActivities = activities;
    return <div data-testid="aerobic-efficiency" />;
  },
}));
vi.mock("../../components/ChartDescriptionTooltip.tsx", () => ({
  ChartDescriptionTooltip: () => null,
}));
vi.mock("../../components/EftpTrendChart.tsx", () => ({
  EftpTrendChart: () => <div data-testid="eftp-trend" />,
}));
vi.mock("../../components/PmcChart.tsx", () => ({
  PmcChart: () => <div data-testid="pmc-chart" />,
}));
vi.mock("../../components/PowerCurveChart.tsx", () => ({
  PowerCurveChart: () => <div data-testid="power-curve" />,
}));
vi.mock("../../components/RecentActivitiesSection.tsx", () => ({
  RecentActivitiesSection: () => <div data-testid="recent-activities" />,
}));
vi.mock("../../components/VerticalAscentChart.tsx", () => ({
  VerticalAscentChart: () => <div data-testid="vertical-ascent" />,
}));
vi.mock("../../lib/chartTheme.ts", () => ({
  chartColors: { purple: "purple" },
  chartThemeColors: { axisLabel: "gray" },
}));
vi.mock("../../lib/trainingDaysContext.ts", async () => {
  const { createContext, useContext } = await vi.importActual<typeof import("react")>("react");
  const TrainingDaysContext = createContext<{
    days: number | null;
    setDays: (days: number | null) => void;
  }>({
    days: state.selectedDays,
    setDays: () => {},
  });

  return {
    TrainingDaysContext,
    useTrainingDays: () => useContext(TrainingDaysContext),
  };
});

const emptyQuery = { data: [], isLoading: false, error: null };

vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      cycling: {
        activities: {
          invalidate: async () => state.invalidatedQueries.push("cycling.activities"),
        },
        performance: {
          invalidate: async () => state.invalidatedQueries.push("cycling.performance"),
        },
      },
      calendar: {
        weekList: {
          invalidate: async () => state.invalidatedQueries.push("calendar.weekList"),
        },
        activityOverview: {
          invalidate: async () => state.invalidatedQueries.push("calendar.activityOverview"),
        },
      },
    }),
    activity: {
      bulkDelete: {
        useMutation: (options: { onSuccess: () => Promise<void> }) => {
          state.bulkDeleteOnSuccess = options.onSuccess;
          return { mutate: vi.fn(), isPending: false, error: null };
        },
      },
    },
    cycling: {
      performance: {
        useQuery: (input: { days: number | null }) => {
          const period = (watts: number, cp: number) => ({
            points: [
              {
                durationSeconds: 300,
                bestPower: watts,
                label: "5m",
                activityDate: "2026-03-15",
              },
            ],
            model: { cp, wPrime: 20_000, r2: 0.95 },
          });
          const summary = (watts: number, wattsPerKg: number, vo2Max: number) => ({
            efforts: [
              {
                durationSeconds: 300,
                watts,
                wattsPerKg,
              },
            ],
            maximalAerobicPower: watts,
            vo2Max,
            timeToExhaustionSeconds: state.timeToExhaustionAvailable ? 200 : null,
          });
          return {
            ...recordQuery("cycling.performance")(input),
            error: state.performanceError,
            data: state.performanceHasData
              ? {
                  powerCurve: { recent: period(400, 300), season: period(500, 350) },
                  powerSummary: {
                    weightKg: 100,
                    recent: summary(400, 4, 50.2),
                    season: summary(500, 5, 61),
                  },
                  pmc: {
                    data: [],
                    model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
                  },
                  eftpTrend: { trend: [], currentEftp: null, model: null },
                  estimateEvidence: {
                    recent: {
                      threshold: {
                        method: "Critical Power model fitted to 120–600 second best-power efforts",
                        confidence: "high",
                        confidenceLabel: "High fit quality",
                        confidenceDetail: "High fit quality across 5 observed power durations.",
                        sourceWorkouts: [
                          {
                            id: "ride-1",
                            name: "Threshold Intervals",
                            date: "2026-03-15",
                          },
                        ],
                        pacingGuidance: "Use this as a training estimate, not a tested threshold.",
                      },
                      vo2Max: {
                        method:
                          "Indirect estimate from 5-minute maximal aerobic power and latest body weight",
                        confidence: "limited",
                        confidenceLabel: "Indirect estimate",
                        confidenceDetail: "A field estimate, not a laboratory measurement.",
                        sourceWorkouts: [
                          { id: "ride-1", name: "Threshold Intervals", date: "2026-03-15" },
                        ],
                        pacingGuidance: "Do not use this estimate to set workout pacing.",
                      },
                    },
                    season: {
                      threshold: {
                        method: "Critical Power model fitted to 120–600 second best-power efforts",
                        confidence: "moderate",
                        confidenceLabel: "Moderate fit quality",
                        confidenceDetail: "Moderate fit quality across 5 observed power durations.",
                        sourceWorkouts: [],
                        pacingGuidance: "Use this as a training estimate, not a tested threshold.",
                      },
                      vo2Max: {
                        method:
                          "Indirect estimate from 5-minute maximal aerobic power and latest body weight",
                        confidence: "limited",
                        confidenceLabel: "Indirect estimate",
                        confidenceDetail: "A field estimate, not a laboratory measurement.",
                        sourceWorkouts: [],
                        pacingGuidance: "Do not use this estimate to set workout pacing.",
                      },
                    },
                    eftp: {
                      method:
                        "Critical Power model for the current value; trend points use normalized power × 0.95",
                      confidence: "limited",
                      confidenceLabel: "Training estimate",
                      confidenceDetail: "Based on source cycling workouts.",
                      sourceWorkouts: [
                        { id: "ride-1", name: "Threshold Intervals", date: "2026-03-15" },
                      ],
                      pacingGuidance:
                        "Do not use this estimate to set pacing when the source ride is not representative.",
                    },
                  },
                }
              : undefined,
          };
        },
      },
      activities: {
        useQuery: (input: unknown) => ({
          ...recordQuery("cycling.activities")(input),
          error: state.activityAnalyticsError,
          data: state.activityAnalyticsHasData
            ? {
                activities: { items: [], totalCount: 0 },
                variability: { rows: [], totalCount: 0, emptyReason: null },
                verticalAscent: [],
                aerobicEfficiency: { activities: state.efficiencyActivities, maxHr: null },
              }
            : undefined,
        }),
      },
    },
  },
}));

function recordQuery(name: string) {
  return (input: unknown) => {
    state.queryCalls.push({ name, input });
    return emptyQuery;
  };
}

async function renderCyclingTab() {
  await import("./cycling.tsx");
  const { TrainingDaysContext } = await import("../../lib/trainingDaysContext.ts");
  const CyclingTab = state.capturedRouteComponents["/training/cycling"];
  if (!CyclingTab) throw new Error("Cycling route component was not captured");
  return render(
    <TrainingDaysContext.Provider
      value={{
        days: state.selectedDays,
        setDays: (days) => {
          state.selectedDays = days;
        },
      }}
    >
      <CyclingTab />
    </TrainingDaysContext.Provider>,
  );
}

async function renderCyclingTabInTrainingLayout() {
  await import("./cycling.tsx");
  await import("../training.tsx");
  const CyclingTab = state.capturedRouteComponents["/training/cycling"];
  const TrainingLayout = state.capturedRouteComponents["/training"];
  if (!CyclingTab) throw new Error("Cycling route component was not captured");
  if (!TrainingLayout) throw new Error("Training layout component was not captured");
  state.outletComponent = CyclingTab;
  return render(<TrainingLayout />);
}

describe("CyclingTab", () => {
  beforeEach(() => {
    vi.resetModules();
    state.capturedRouteComponents = {};
    state.outletComponent = null;
    state.efficiencyActivities = [];
    state.capturedAerobicEfficiencyActivities = null;
    state.performanceHasData = true;
    state.timeToExhaustionAvailable = true;
    state.performanceError = null;
    state.activityAnalyticsHasData = true;
    state.activityAnalyticsError = null;
    state.bulkDeleteOnSuccess = null;
    state.invalidatedQueries = [];
    state.queryCalls.length = 0;
    state.selectedDays = 90;
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders power summary values computed by the server", async () => {
    await renderCyclingTab();

    expect(screen.getByText("4.00")).toBeTruthy();
    expect(screen.getByText("5.00")).toBeTruthy();
    expect(screen.getByText("50.2")).toBeTruthy();
    expect(screen.getByText("61")).toBeTruthy();
    expect(screen.getByText("High fit quality")).toBeTruthy();
    expect(screen.getAllByText("Indirect estimate")).toHaveLength(2);
    expect(screen.getAllByText(/Threshold Intervals/)).toHaveLength(3);
    expect(screen.getByText(/Do not use this estimate to set pacing/)).toBeTruthy();
  });

  it("renders unavailable time-to-exhaustion values from the server", async () => {
    state.timeToExhaustionAvailable = false;
    await renderCyclingTab();

    const row = screen.getByText("Time to Exhaustion").parentElement;
    expect(row?.textContent).toContain("--");
  });

  it("keeps cached performance data visible during a background query failure", async () => {
    state.performanceError = new Error("Cycling analytics unavailable");
    await renderCyclingTab();

    expect(screen.getByText("4.00")).toBeTruthy();
    expect(screen.queryByText("Cycling analytics unavailable")).toBeNull();
  });

  it("renders a failed performance query once while keeping activity analytics visible", async () => {
    state.performanceHasData = false;
    state.performanceError = new Error("Cycling performance unavailable");

    await renderCyclingTab();

    expect(screen.getAllByText("Cycling performance unavailable")).toHaveLength(1);
    expect(screen.getByTestId("aerobic-efficiency")).toBeTruthy();
    expect(screen.getByTestId("vertical-ascent")).toBeTruthy();
  });

  it("renders a failed activity query once while keeping performance analytics visible", async () => {
    state.activityAnalyticsHasData = false;
    state.activityAnalyticsError = new Error("Cycling activities unavailable");

    await renderCyclingTab();

    expect(screen.getAllByText("Cycling activities unavailable")).toHaveLength(1);
    expect(screen.getByTestId("power-curve")).toBeTruthy();
    expect(screen.getByTestId("pmc-chart")).toBeTruthy();
  });

  it("keeps equal messages separate when they belong to distinct failed queries", async () => {
    state.performanceHasData = false;
    state.performanceError = new Error("Cycling data unavailable");
    state.activityAnalyticsHasData = false;
    state.activityAnalyticsError = new Error("Cycling data unavailable");

    await renderCyclingTab();

    expect(screen.getAllByText("Cycling data unavailable")).toHaveLength(2);
  });

  it("invalidates both cycling query groups after deleting activities", async () => {
    await renderCyclingTab();

    await state.bulkDeleteOnSuccess?.();

    expect(state.invalidatedQueries).toEqual([
      "cycling.activities",
      "cycling.performance",
      "calendar.weekList",
      "calendar.activityOverview",
    ]);
  });

  it("passes server-filtered aerobic efficiency activities to the chart", async () => {
    const cyclingActivity = {
      date: "2026-03-10",
      activityType: "cycling",
      name: "Morning Ride",
      avgPowerZ2: 180,
      avgHrZ2: 135,
      efficiencyFactor: 1.333,
      z2Samples: 600,
    };
    state.efficiencyActivities = [cyclingActivity];

    await renderCyclingTab();

    expect(state.capturedAerobicEfficiencyActivities).toEqual([cyclingActivity]);
  });

  it("uses the selected days for every selected-range chart query", async () => {
    state.selectedDays = 365;

    await renderCyclingTab();

    expect(state.queryCalls).toEqual([
      { name: "cycling.performance", input: { days: 365 } },
      {
        name: "cycling.activities",
        input: {
          days: 365,
          activityLimit: 20,
          activityOffset: 0,
          variabilityLimit: 20,
          variabilityOffset: 0,
        },
      },
    ]);
  });

  it("passes null for All to selected-range chart queries while keeping fixed support windows", async () => {
    state.selectedDays = null;

    await renderCyclingTab();

    expect(state.queryCalls).toEqual([
      { name: "cycling.performance", input: { days: null } },
      {
        name: "cycling.activities",
        input: {
          days: null,
          activityLimit: 20,
          activityOffset: 0,
          variabilityLimit: 20,
          variabilityOffset: 0,
        },
      },
    ]);
  });

  it("selecting All in the training header passes null to cycling selected-range queries", async () => {
    await renderCyclingTabInTrainingLayout();

    state.queryCalls.length = 0;
    fireEvent.click(screen.getByRole("radio", { name: "All" }));

    expect(state.queryCalls).toEqual([
      { name: "cycling.performance", input: { days: null } },
      {
        name: "cycling.activities",
        input: {
          days: null,
          activityLimit: 20,
          activityOffset: 0,
          variabilityLimit: 20,
          variabilityOffset: 0,
        },
      },
    ]);
  });

  it("resets both cycling pagination cursors when the selected range changes", async () => {
    await renderCyclingTabInTrainingLayout();

    fireEvent.click(screen.getByRole("button", { name: "Next activity page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next variability page" }));
    expect(
      state.queryCalls.filter((queryCall) => queryCall.name === "cycling.activities").at(-1),
    ).toEqual({
      name: "cycling.activities",
      input: expect.objectContaining({ activityOffset: 20, variabilityOffset: 20 }),
    });

    fireEvent.click(screen.getByRole("radio", { name: "All" }));

    expect(
      state.queryCalls.filter((queryCall) => queryCall.name === "cycling.activities").at(-1),
    ).toEqual({
      name: "cycling.activities",
      input: expect.objectContaining({ days: null, activityOffset: 0, variabilityOffset: 0 }),
    });
  });
});
