/** @vitest-environment jsdom */

import { render } from "@testing-library/react";
import type { ComponentType } from "react";
import { expect, vi } from "vitest";
import { SELECTED_RANGE_QUERY_REGISTRY } from "../../lib/selectedRangeQueryRegistry.test-helper.ts";
import type { TimeRangeDays } from "../../lib/timeRange.ts";

const state: {
  days: TimeRangeDays;
  queryCalls: Array<{ name: string; input: unknown; options?: unknown }>;
  recentActivitiesProps: Array<{
    activityTypes?: readonly string[];
    emptyMessage?: string;
  }>;
  recentActivityTypes: readonly string[] | undefined;
  routeComponents: Record<string, ComponentType>;
  trainingVolumeQuery: {
    data: unknown;
    isLoading: boolean;
    error: Error | null;
  };
  trainingHrZonesQuery: {
    data: unknown;
    isLoading: boolean;
    error: Error | null;
  };
} = {
  days: 90,
  queryCalls: [],
  recentActivitiesProps: [],
  recentActivityTypes: undefined,
  routeComponents: {},
  trainingVolumeQuery: { data: [], isLoading: false, error: null },
  trainingHrZonesQuery: {
    data: {
      maxHr: null,
      weeks: [],
      intensityDistribution: {
        model: "karvonen-five-zone",
        activityScope: "endurance",
        totalSeconds: 0,
        zones: [],
        explanation: "Server intensity explanation",
      },
    },
    isLoading: false,
    error: null,
  },
};

export { state };

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
  ChartDescriptionTooltip: ({ description }: { description: string }) => (
    <button type="button" aria-label="About this chart" data-description={description}>
      About
    </button>
  ),
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
vi.mock("../../components/QueryStatePanel.tsx", () => ({
  QueryStatePanel: ({ error }: { error?: Error }) => <div>{error?.message}</div>,
}));
vi.mock("../../components/RampRateChart.tsx", () => ({ RampRateChart: () => <div /> }));
vi.mock("../../components/ReadinessScoreCard.tsx", () => ({ ReadinessScoreCard: () => <div /> }));
vi.mock("../../components/RecentActivitiesSection.tsx", () => ({
  RecentActivitiesSection: (props: {
    activityTypes?: readonly string[];
    emptyMessage?: string;
  }) => {
    state.recentActivitiesProps.push(props);
    state.recentActivityTypes = props.activityTypes;
    return <div>Recent activities</div>;
  },
}));
vi.mock("../../components/SleepAnalyticsChart.tsx", () => ({ SleepAnalyticsChart: () => <div /> }));
vi.mock("../../components/StrengthVolumeChart.tsx", () => ({ StrengthVolumeChart: () => <div /> }));
vi.mock("../../components/TrainingMonotonyChart.tsx", () => ({
  TrainingMonotonyChart: () => <div />,
}));
vi.mock("../../components/TodayPlanCard.tsx", () => ({
  TodayPlanCard: ({ plan }: { plan?: { status: "ready"; action: { title: string } } }) => (
    <section aria-label="What matters today">{plan?.action.title}</section>
  ),
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
      workloadRatio: {
        useQuery: (input: unknown, options?: unknown) => {
          state.queryCalls.push({ name: "recovery.workloadRatio", input, options });
          return {
            data: {
              context: {
                label: "Recent-to-baseline workload ratio",
                description:
                  "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
                recentDays: 7,
                baselineDays: 28,
              },
              displayedStrain: 0,
              displayedDate: null,
              timeSeries: [],
            },
            isLoading: false,
            error: null,
          };
        },
      },
    },
    todayPlan: {
      get: {
        useQuery: (input: unknown, options?: unknown) => {
          state.queryCalls.push({ name: "todayPlan.get", input, options });
          return {
            data: {
              status: "ready" as const,
              action: { title: "Server-authored recovery action" },
            },
            isLoading: false,
            error: null,
          };
        },
      },
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
          return state.trainingHrZonesQuery;
        },
      },
      weeklyVolume: {
        useQuery: (input: unknown, options?: unknown) => {
          state.queryCalls.push({ name: "training.weeklyVolume", input, options });
          return state.trainingVolumeQuery;
        },
      },
    },
  },
}));

export async function renderRoute(routePath: string, importRoute: () => Promise<unknown>) {
  await importRoute();
  const RouteComponent = state.routeComponents[routePath];
  if (!RouteComponent) throw new Error(`${routePath} route component was not captured`);
  return render(<RouteComponent />);
}

export function expectRegistryInputs(
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

export function resetRangePlumbingState() {
  state.days = 90;
  state.queryCalls.length = 0;
  state.recentActivitiesProps.length = 0;
  state.recentActivityTypes = undefined;
  state.trainingVolumeQuery = { data: [], isLoading: false, error: null };
  state.trainingHrZonesQuery = {
    data: {
      maxHr: null,
      weeks: [],
      intensityDistribution: {
        model: "karvonen-five-zone",
        activityScope: "endurance",
        totalSeconds: 0,
        zones: [],
        explanation: "Server intensity explanation",
      },
    },
    isLoading: false,
    error: null,
  };
}
