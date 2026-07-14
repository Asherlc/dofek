/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted<{
  capturedRouteComponents: Record<string, ComponentType>;
  outletComponent: ComponentType | null;
  bodyRecords: Array<{ recordedAt: string; weightKg: number | null }>;
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
  queryCalls: Array<{ name: string; input: unknown }>;
  selectedDays: number | null;
}>(() => ({
  capturedRouteComponents: {},
  outletComponent: null,
  bodyRecords: [],
  efficiencyActivities: [],
  capturedAerobicEfficiencyActivities: null,
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
  ActivityVariabilityTable: () => <div data-testid="activity-variability" />,
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
      cycling: { activities: { invalidate: vi.fn() } },
      calendar: {
        weekList: { invalidate: vi.fn() },
        activityOverview: { invalidate: vi.fn() },
      },
    }),
    activity: {
      bulkDelete: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
      },
    },
    cycling: {
      performance: {
        useQuery: (input: { days: number | null }) => {
          const latestWeight = state.bodyRecords
            .filter((record) => typeof record.weightKg === "number")
            .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0]?.weightKg;
          const weightKg = typeof latestWeight === "number" ? latestWeight : null;
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
          const summary = (watts: number) => ({
            efforts: [
              {
                durationSeconds: 300,
                watts,
                wattsPerKg: weightKg == null ? null : watts / weightKg,
              },
            ],
            maximalAerobicPower: watts,
            vo2Max: weightKg == null ? null : Math.round(((watts / weightKg) * 10.8 + 7) * 10) / 10,
            timeToExhaustionSeconds: 200,
          });
          return {
            ...recordQuery("cycling.performance")(input),
            data: {
              powerCurve: { recent: period(400, 300), season: period(500, 350) },
              powerSummary: { weightKg, recent: summary(400), season: summary(500) },
              pmc: {
                data: [],
                model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
              },
              eftpTrend: { trend: [], currentEftp: null, model: null },
            },
          };
        },
      },
      activities: {
        useQuery: (input: unknown) => ({
          ...recordQuery("cycling.activities")(input),
          data: {
            activities: { items: [], totalCount: 0 },
            variability: { rows: [], totalCount: 0, emptyReason: null },
            verticalAscent: [],
            aerobicEfficiency: { activities: state.efficiencyActivities, maxHr: null },
          },
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
    state.bodyRecords = [
      { recordedAt: "2026-07-01", weightKg: null },
      { recordedAt: "2026-06-01", weightKg: 100 },
    ];
    state.efficiencyActivities = [];
    state.capturedAerobicEfficiencyActivities = null;
    state.queryCalls.length = 0;
    state.selectedDays = 90;
  });

  afterEach(() => {
    cleanup();
  });

  it("uses the latest body record with a numeric weight for watts per kilogram calculations", async () => {
    await renderCyclingTab();

    expect(screen.getByText("4.00")).toBeTruthy();
    expect(screen.getByText("5.00")).toBeTruthy();
    expect(screen.getByText("50.2")).toBeTruthy();
    expect(screen.getByText("61")).toBeTruthy();
  });

  it("uses the newest numeric weight even when body records are out of order", async () => {
    state.bodyRecords = [
      { recordedAt: "2026-04-01", weightKg: 90 },
      { recordedAt: "2026-07-01", weightKg: 80 },
      { recordedAt: "2026-06-01", weightKg: 100 },
    ];

    await renderCyclingTab();

    expect(screen.getByText("5.00")).toBeTruthy();
    expect(screen.getByText("6.25")).toBeTruthy();
  });

  it("omits watts per kilogram and VO2max metrics when no numeric weight exists", async () => {
    state.bodyRecords = [
      { recordedAt: "2026-07-01", weightKg: null },
      { recordedAt: "2026-06-01", weightKg: null },
    ];

    await renderCyclingTab();

    expect(screen.getAllByText("--").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("4.00")).toBeNull();
    expect(screen.queryByText("50.2")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "All" }));

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
});
