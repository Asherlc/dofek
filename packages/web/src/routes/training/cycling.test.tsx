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
    power: {
      powerCurve: {
        useQuery: (input: { days: number | null }) => ({
          ...recordQuery("powerCurve")(input),
          data: {
            points: [
              {
                durationSeconds: 300,
                bestPower: input.days === 365 ? 500 : 400,
                label: "5m",
                activityDate: "2026-03-15",
              },
            ],
            model: { cp: input.days === 365 ? 350 : 300, wPrime: 20_000, r2: 0.95 },
          },
        }),
      },
      eftpTrend: {
        useQuery: (input: unknown) => ({
          ...recordQuery("eftpTrend")(input),
          data: { trend: [], currentEftp: null },
        }),
      },
    },
    pmc: {
      chart: {
        useQuery: (input: unknown) => ({
          ...recordQuery("pmc")(input),
          data: { data: [], model: null },
        }),
      },
    },
    efficiency: {
      aerobicEfficiency: {
        useQuery: (input: unknown) => ({
          ...recordQuery("aerobicEfficiency")(input),
          data: { activities: state.efficiencyActivities, maxHr: null },
        }),
      },
    },
    cyclingAdvanced: {
      activityVariability: {
        useQuery: (input: unknown) => ({
          ...recordQuery("activityVariability")(input),
          data: { rows: [], totalCount: 0 },
        }),
      },
      verticalAscentRate: {
        useQuery: (input: unknown) => recordQuery("verticalAscentRate")(input),
      },
    },
    body: {
      list: {
        useQuery: (input: unknown) => ({
          ...recordQuery("bodyList")(input),
          data: state.bodyRecords,
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

  it("passes only cycling aerobic efficiency activities to the chart", async () => {
    const cyclingActivity = {
      date: "2026-03-10",
      activityType: "cycling",
      name: "Morning Ride",
      avgPowerZ2: 180,
      avgHrZ2: 135,
      efficiencyFactor: 1.333,
      z2Samples: 600,
    };
    state.efficiencyActivities = [
      cyclingActivity,
      {
        date: "2026-03-12",
        activityType: "running",
        name: "Easy Run",
        avgPowerZ2: 220,
        avgHrZ2: 145,
        efficiencyFactor: 1.517,
        z2Samples: 900,
      },
    ];

    await renderCyclingTab();

    expect(state.capturedAerobicEfficiencyActivities).toEqual([cyclingActivity]);
  });

  it("uses the selected days for every selected-range chart query", async () => {
    state.selectedDays = 365;

    await renderCyclingTab();

    expect(state.queryCalls).toEqual(
      expect.arrayContaining([
        { name: "powerCurve", input: { days: 365 } },
        { name: "eftpTrend", input: { days: 365 } },
        { name: "pmc", input: { days: 365 } },
        { name: "aerobicEfficiency", input: { days: 365 } },
        {
          name: "activityVariability",
          input: { days: 365, limit: 20, offset: 0 },
        },
        { name: "verticalAscentRate", input: { days: 365 } },
      ]),
    );
    expect(state.queryCalls).toEqual(
      expect.arrayContaining([
        { name: "powerCurve", input: { days: 365 } },
        { name: "bodyList", input: { days: 365 } },
      ]),
    );
  });

  it("passes null for All to selected-range chart queries while keeping fixed support windows", async () => {
    state.selectedDays = null;

    await renderCyclingTab();

    expect(state.queryCalls).toEqual(
      expect.arrayContaining([
        { name: "powerCurve", input: { days: null } },
        { name: "eftpTrend", input: { days: null } },
        { name: "pmc", input: { days: null } },
        { name: "aerobicEfficiency", input: { days: null } },
        {
          name: "activityVariability",
          input: { days: null, limit: 20, offset: 0 },
        },
        { name: "verticalAscentRate", input: { days: null } },
      ]),
    );
    expect(state.queryCalls.filter((call) => call.name === "powerCurve")).toEqual([
      { name: "powerCurve", input: { days: null } },
      { name: "powerCurve", input: { days: 365 } },
    ]);
    expect(state.queryCalls).toContainEqual({ name: "bodyList", input: { days: 365 } });
  });

  it("selecting All in the training header passes null to cycling selected-range queries", async () => {
    await renderCyclingTabInTrainingLayout();

    state.queryCalls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    expect(state.queryCalls).toEqual(
      expect.arrayContaining([
        { name: "powerCurve", input: { days: null } },
        { name: "eftpTrend", input: { days: null } },
        { name: "pmc", input: { days: null } },
        { name: "aerobicEfficiency", input: { days: null } },
        {
          name: "activityVariability",
          input: { days: null, limit: 20, offset: 0 },
        },
        { name: "verticalAscentRate", input: { days: null } },
      ]),
    );
    expect(state.queryCalls.filter((call) => call.name === "powerCurve")).toEqual([
      { name: "powerCurve", input: { days: null } },
      { name: "powerCurve", input: { days: 365 } },
    ]);
  });
});
