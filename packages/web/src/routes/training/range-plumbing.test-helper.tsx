vi.mock("../../components/StrengthLoggedSetComparison", () => ({
  StrengthLoggedSetComparison: ({
    progressionRows,
  }: {
    progressionRows?: Array<{ identityKey: string }>;
  }) => <div data-testid="progression-rows-count">{progressionRows?.length ?? 0}</div>,
}));

/** @vitest-environment jsdom */

import { render } from "@testing-library/react";
import type { ComponentType } from "react";
import { expect, vi } from "vitest";
import { SELECTED_RANGE_QUERY_REGISTRY } from "../../lib/selectedRangeQueryRegistry.test-helper.ts";
import type { TimeRangeDays } from "../../lib/timeRange.ts";

const state: {
  days: TimeRangeDays;
  queryCalls: Array<{ name: string; input: unknown; options?: unknown }>;
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
  dailyMetricsQuery: { data: unknown; isLoading: boolean; error: Error | null };
  trainingProgressionStrengthQuery: { data: unknown; isLoading: boolean; error: Error | null };
} = {
  days: 90,
  queryCalls: [],
  routeComponents: {},
  trainingProgressionStrengthQuery: { data: [], isLoading: false, error: null },
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
  dailyMetricsQuery: { data: [], isLoading: false, error: null },
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
  QueryStatePanel: ({
    error,
    message,
    variant,
  }: {
    error?: Error;
    message?: string;
    variant?: string;
  }) => (
    <div data-testid={variant ? `query-state-${variant}` : undefined}>
      {message ?? error?.message}
    </div>
  ),
}));
vi.mock("../../components/SleepAnalyticsChart.tsx", () => ({ SleepAnalyticsChart: () => <div /> }));
vi.mock("../../components/StrengthVolumeChart.tsx", () => ({ StrengthVolumeChart: () => <div /> }));
vi.mock("../../components/WorkloadRatioChart.tsx", () => ({ WorkloadRatioChart: () => <div /> }));
vi.mock("../../components/DofekChart.tsx", () => ({ DofekChart: () => <div /> }));
vi.mock("../../components/TimeSeriesChart.tsx", () => ({
  TimeSeriesChart: ({ series }: { series: Array<{ name: string; data: unknown[] }> }) => (
    <div data-testid="recovery-temperature-series">{JSON.stringify(series)}</div>
  ),
}));
vi.mock("../../components/HeartRateZonesChart.tsx", () => ({
  WeeklyHrZonesChart: () => <div />,
}));

vi.mock("../../lib/trainingDaysContext.ts", () => ({
  useTrainingDays: () => ({ days: state.days }),
}));

vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    cyclingAdvanced: {},
    dailyMetrics: {
      list: {
        useQuery: (input: unknown, options?: unknown) => {
          state.queryCalls.push({ name: "dailyMetrics.list", input, options });
          return state.dailyMetricsQuery;
        },
      },
      hrvBaseline: { useQuery: recordQuery("dailyMetrics.hrvBaseline") },
    },
    efficiency: {
      polarizationTrend: { useQuery: recordQuery("efficiency.polarizationTrend") },
    },
    recovery: {
      hrvVariability: { useQuery: recordQuery("recovery.hrvVariability") },
      sleepAnalytics: { useQuery: recordQuery("recovery.sleepAnalytics") },
      workloadRatio: {
        useQuery: (input: unknown, options?: unknown) => {
          state.queryCalls.push({ name: "recovery.workloadRatio", input, options });
          return {
            data: {
              context: {
                label: "Recent-to-baseline workload ratio",
                description:
                  "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days.",
                recentDays: 7,
                baselineDays: 28,
              },
              timeSeries: [],
            },
            isLoading: false,
            error: null,
          };
        },
      },
    },
    trainingProgression: {
      strength: {
        useQuery: (input: unknown, options?: unknown) => {
          state.queryCalls.push({ name: "trainingProgression.strength", input, options });
          return state.trainingProgressionStrengthQuery;
        },
      },
    },
    strength: {
      loggedSetComparison: { useQuery: recordQuery("strength.loggedSetComparison") },
      estimatedOneRepMax: { useQuery: recordQuery("strength.estimatedOneRepMax") },
      exerciseHistory: { useQuery: recordQuery("strength.exerciseHistory") },
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
  state.trainingProgressionStrengthQuery = { data: [], isLoading: false, error: null };
  state.trainingVolumeQuery = { data: [], isLoading: false, error: null };
  state.dailyMetricsQuery = { data: [], isLoading: false, error: null };
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

vi.mock("../../components/SportVolumeChart.tsx", () => ({ SportVolumeChart: () => <div /> }));
