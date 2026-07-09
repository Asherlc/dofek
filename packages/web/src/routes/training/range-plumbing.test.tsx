/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELECTED_RANGE_QUERY_REGISTRY, type TimeRangeDays } from "../../lib/timeRange.ts";

const state = vi.hoisted<{
  days: TimeRangeDays;
  queryCalls: Array<{ name: string; input: unknown; options?: unknown }>;
  routeComponents: Record<string, ComponentType>;
}>(() => ({
  days: 90,
  queryCalls: [],
  routeComponents: {},
}));

function recordQuery(name: string) {
  return (input: unknown, options?: unknown) => {
    state.queryCalls.push({ name, input, options });
    return { data: [], isLoading: false, error: null };
  };
}

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (path: string) => (config: { component?: ComponentType }) => {
    if (config.component) state.routeComponents[path] = config.component;
    return {};
  },
  createLazyFileRoute: (path: string) => (config: { component: ComponentType }) => {
    state.routeComponents[path] = config.component;
    return {};
  },
}));

vi.mock("../../components/ChartDescriptionTooltip.tsx", () => ({
  ChartDescriptionTooltip: () => null,
}));
vi.mock("../../components/EstimatedMaxChart.tsx", () => ({ EstimatedMaxChart: () => <div /> }));
vi.mock("../../components/HrvBaselineChart.tsx", () => ({ HrvBaselineChart: () => <div /> }));
vi.mock("../../components/HrvVariabilityChart.tsx", () => ({
  HrvVariabilityChart: () => <div />,
}));
vi.mock("../../components/MuscleGroupVolumeChart.tsx", () => ({
  MuscleGroupVolumeChart: () => <div />,
}));
vi.mock("../../components/PolarizationTrendChart.tsx", () => ({
  PolarizationTrendChart: () => <div />,
}));
vi.mock("../../components/ProgressiveOverloadCards.tsx", () => ({
  ProgressiveOverloadCards: () => <div />,
}));
vi.mock("../../components/QueryStatePanel.tsx", () => ({ QueryStatePanel: () => <div /> }));
vi.mock("../../components/RampRateChart.tsx", () => ({ RampRateChart: () => <div /> }));
vi.mock("../../components/ReadinessScoreCard.tsx", () => ({ ReadinessScoreCard: () => <div /> }));
vi.mock("../../components/RecentActivitiesSection.tsx", () => ({
  RecentActivitiesSection: () => <div />,
}));
vi.mock("../../components/SleepAnalyticsChart.tsx", () => ({ SleepAnalyticsChart: () => <div /> }));
vi.mock("../../components/StrengthVolumeChart.tsx", () => ({ StrengthVolumeChart: () => <div /> }));
vi.mock("../../components/TrainingMonotonyChart.tsx", () => ({
  TrainingMonotonyChart: () => <div />,
}));
vi.mock("../../components/WorkloadRatioChart.tsx", () => ({ WorkloadRatioChart: () => <div /> }));
vi.mock("../../components/DofekChart.tsx", () => ({ DofekChart: () => <div /> }));
vi.mock("../../components/HeartRateZonesChart.tsx", () => ({
  WeeklyHrZonesChart: () => <div />,
}));

vi.mock("../../lib/trainingDaysContext.ts", () => ({
  useTrainingDays: () => ({ days: state.days }),
}));

vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    cyclingAdvanced: {
      rampRate: { useQuery: recordQuery("cyclingAdvanced.rampRate") },
      trainingMonotony: { useQuery: recordQuery("cyclingAdvanced.trainingMonotony") },
    },
    dailyMetrics: {
      hrvBaseline: { useQuery: recordQuery("dailyMetrics.hrvBaseline") },
    },
    efficiency: {
      polarizationTrend: { useQuery: recordQuery("efficiency.polarizationTrend") },
    },
    recovery: {
      hrvVariability: { useQuery: recordQuery("recovery.hrvVariability") },
      readinessScore: { useQuery: recordQuery("recovery.readinessScore") },
      sleepAnalytics: { useQuery: recordQuery("recovery.sleepAnalytics") },
      workloadRatio: { useQuery: recordQuery("recovery.workloadRatio") },
    },
    strength: {
      estimatedOneRepMax: { useQuery: recordQuery("strength.estimatedOneRepMax") },
      muscleGroupVolume: { useQuery: recordQuery("strength.muscleGroupVolume") },
      progressiveOverload: { useQuery: recordQuery("strength.progressiveOverload") },
      volumeOverTime: { useQuery: recordQuery("strength.volumeOverTime") },
    },
    training: {
      hrZones: {
        useQuery: (input: unknown, options?: unknown) => {
          state.queryCalls.push({ name: "training.hrZones", input, options });
          return { data: { maxHr: null, weeks: [] }, isLoading: false, error: null };
        },
      },
      weeklyVolume: { useQuery: recordQuery("training.weeklyVolume") },
    },
  },
}));

async function renderRoute(routePath: string, importRoute: () => Promise<unknown>) {
  await importRoute();
  const RouteComponent = state.routeComponents[routePath];
  if (!RouteComponent) throw new Error(`${routePath} route component was not captured`);
  return render(<RouteComponent />);
}

function expectRegistryInputs(
  registryKey: keyof typeof SELECTED_RANGE_QUERY_REGISTRY,
  days: TimeRangeDays,
) {
  for (const queryName of SELECTED_RANGE_QUERY_REGISTRY[registryKey]) {
    expect(state.queryCalls).toContainEqual(
      expect.objectContaining({
        name: queryName,
        input: expect.objectContaining({ days }),
      }),
    );
  }
}

describe("training range plumbing", () => {
  beforeEach(() => {
    state.days = 90;
    state.queryCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("passes finite and All ranges to endurance selected-range chart queries", async () => {
    state.days = 30;
    await renderRoute("/training/endurance", () => import("./endurance.tsx"));
    expectRegistryInputs("endurance", 30);

    cleanup();
    state.queryCalls.length = 0;
    state.days = null;
    await renderRoute("/training/endurance", () => import("./endurance.tsx"));
    expectRegistryInputs("endurance", null);
  });

  it("passes finite and All ranges to recovery selected-range chart queries", async () => {
    state.days = 30;
    await renderRoute("/training/recovery", () => import("./recovery.tsx"));
    expectRegistryInputs("recovery", 30);

    cleanup();
    state.queryCalls.length = 0;
    state.days = null;
    await renderRoute("/training/recovery", () => import("./recovery.tsx"));
    expectRegistryInputs("recovery", null);
  });

  it("passes finite and All ranges to strength selected-range chart queries", async () => {
    state.days = 30;
    await renderRoute("/training/strength", () => import("./strength.lazy.tsx"));
    expectRegistryInputs("strength", 30);

    cleanup();
    state.queryCalls.length = 0;
    state.days = null;
    await renderRoute("/training/strength", () => import("./strength.lazy.tsx"));
    expectRegistryInputs("strength", null);
  });

  it("passes finite and All ranges to training insight panel selected-range chart queries", async () => {
    const { TrainingInsightsPanel } = await import("../../components/TrainingInsightsPanel.tsx");

    render(<TrainingInsightsPanel days={30} />);
    expectRegistryInputs("trainingInsightsPanel", 30);

    cleanup();
    state.queryCalls.length = 0;
    render(<TrainingInsightsPanel days={null} />);
    expectRegistryInputs("trainingInsightsPanel", null);
  });
});
