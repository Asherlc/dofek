/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted<{
  capturedRouteComponent: ComponentType | null;
}>(() => ({
  capturedRouteComponent: null,
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
  AerobicEfficiencyChart: () => <div data-testid="aerobic-efficiency" />,
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
  useTrainingDays: () => ({ days: 90 }),
}));

const emptyQuery = { data: [], isLoading: false, error: null };

vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    power: {
      powerCurve: {
        useQuery: (input: { days: number }) => ({
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
          isLoading: false,
          error: null,
        }),
      },
      eftpTrend: {
        useQuery: () => ({ data: { trend: [], currentEftp: null }, isLoading: false, error: null }),
      },
    },
    pmc: {
      chart: {
        useQuery: () => ({ data: { data: [], model: null }, isLoading: false, error: null }),
      },
    },
    efficiency: {
      aerobicEfficiency: {
        useQuery: () => ({ data: { activities: [], maxHr: null }, isLoading: false, error: null }),
      },
    },
    cyclingAdvanced: {
      activityVariability: {
        useQuery: () => ({ data: { rows: [], totalCount: 0 }, isLoading: false, error: null }),
      },
      verticalAscentRate: { useQuery: () => emptyQuery },
    },
    body: {
      list: {
        useQuery: () => ({
          data: [
            { recordedAt: "2026-07-01", weightKg: null },
            { recordedAt: "2026-06-01", weightKg: 100 },
          ],
          isLoading: false,
          error: null,
        }),
      },
    },
  },
}));

async function renderCyclingTab() {
  await import("./cycling.tsx");
  if (!state.capturedRouteComponent) throw new Error("Cycling route component was not captured");
  const CyclingTab = state.capturedRouteComponent;
  return render(<CyclingTab />);
}

describe("CyclingTab", () => {
  beforeEach(() => {
    state.capturedRouteComponent = null;
    vi.resetModules();
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
});
