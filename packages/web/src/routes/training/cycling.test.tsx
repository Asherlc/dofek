/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted<{
  capturedRouteComponent: ComponentType | null;
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
  selectedDays: number;
}>(() => ({
  capturedRouteComponent: null,
  bodyRecords: [],
  efficiencyActivities: [],
  capturedAerobicEfficiencyActivities: null,
  queryCalls: [],
  selectedDays: 90,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: { component: ComponentType }) => {
    state.capturedRouteComponent = config.component;
    return {};
  },
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
vi.mock("../../lib/trainingDaysContext.ts", () => ({
  useTrainingDays: () => ({ days: state.selectedDays }),
}));

const emptyQuery = { data: [], isLoading: false, error: null };

vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    power: {
      powerCurve: {
        useQuery: (input: { days: number }) => ({
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
  if (!state.capturedRouteComponent) throw new Error("Cycling route component was not captured");
  const CyclingTab = state.capturedRouteComponent;
  return render(<CyclingTab />);
}

describe("CyclingTab", () => {
  beforeEach(() => {
    vi.resetModules();
    state.capturedRouteComponent = null;
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
    state.selectedDays = 3650;

    await renderCyclingTab();

    expect(state.queryCalls).toEqual(
      expect.arrayContaining([
        { name: "powerCurve", input: { days: 3650 } },
        { name: "eftpTrend", input: { days: 3650 } },
        { name: "pmc", input: { days: 3650 } },
        { name: "aerobicEfficiency", input: { days: 3650 } },
        {
          name: "activityVariability",
          input: { days: 3650, limit: 20, offset: 0 },
        },
        { name: "verticalAscentRate", input: { days: 3650 } },
      ]),
    );
  });
});
