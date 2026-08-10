/** @vitest-environment jsdom */

import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { expect, vi } from "vitest";
import { BodyDaysContext } from "../../lib/bodyDaysContext.ts";
import { SELECTED_RANGE_QUERY_REGISTRY } from "../../lib/selectedRangeQueryRegistry.test-helper.ts";
import { emptyJournalTrendEvidence } from "../journal-trend-test-fixtures.ts";

const state = vi.hoisted<{
  queryCalls: Array<{ name: string; input: unknown }>;
  routeComponents: Record<string, ComponentType>;
}>(() => ({
  queryCalls: [],
  routeComponents: {},
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (path: string) => (config: { component: ComponentType }) => {
    state.routeComponents[path] = config.component;
    return {};
  },
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={typeof to === "string" ? to : "/experiments"}>{children}</a>
  ),
}));

vi.mock("../../hooks/useTodayQueryDate.ts", () => ({
  useTodayQueryDate: () => "2026-07-08",
}));

vi.mock("../../lib/unitContext.ts", () => ({
  useUnitConverter: () => ({
    convertTemperature: (value: number) => value,
    temperatureLabel: "C",
  }),
}));

vi.mock("../AddJournalEntryModal.tsx", () => ({
  AddJournalEntryModal: () => <div data-testid="add-journal-entry-modal" />,
}));
vi.mock("../AdaptiveTdeeChart.tsx", () => ({ AdaptiveTdeeChart: () => <div /> }));
vi.mock("../BehaviorImpactChart.tsx", async () => {
  const actual = await vi.importActual<typeof import("../BehaviorImpactChart.tsx")>(
    "../BehaviorImpactChart.tsx",
  );
  return actual;
});
vi.mock("../BodyRecompositionChart.tsx", () => ({ BodyRecompositionChart: () => <div /> }));
vi.mock("../ChartDescriptionTooltip.tsx", () => ({ ChartDescriptionTooltip: () => null }));
vi.mock("../CorrelationCard.tsx", () => ({
  CorrelationCard: () => <div />,
  CorrelationCardSkeleton: () => <div />,
}));
vi.mock("../GoalWeightInput.tsx", () => ({ GoalWeightInput: () => <div /> }));
vi.mock("../HealthStatusBar.tsx", () => ({ HealthStatusBar: () => <div /> }));
vi.mock("../HrvBaselineChart.tsx", () => ({ HrvBaselineChart: () => <div /> }));
vi.mock("../Hypnogram.tsx", () => ({ Hypnogram: () => <div /> }));
vi.mock("../LoadingSkeleton.tsx", () => ({ ChartLoadingSkeleton: () => <div /> }));
vi.mock("../MicronutrientChart.tsx", () => ({ MicronutrientChart: () => <div /> }));
vi.mock("../PageLayout.tsx", () => ({
  PageLayout: ({
    headerChildren,
    children,
  }: {
    headerChildren?: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      {headerChildren}
      {children}
    </div>
  ),
}));
vi.mock("../PageSection.tsx", () => ({
  PageSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../QueryStatePanel.tsx", () => ({ QueryStatePanel: () => <div /> }));
vi.mock("../SleepChart.tsx", () => ({ SleepChart: () => <div /> }));
vi.mock("../SleepDataSourcesTable.tsx", () => ({ SleepDataSourcesTable: () => <div /> }));
vi.mock("../SleepNeedCard.tsx", () => ({ SleepNeedCard: () => <div /> }));
vi.mock("../SleepPerformanceCard.tsx", () => ({ SleepPerformanceCard: () => <div /> }));
vi.mock("../SmoothedWeightChart.tsx", () => ({ SmoothedWeightChart: () => <div /> }));
vi.mock("../StressChart.tsx", () => ({ StressChart: () => <div /> }));
vi.mock("../TimeSeriesChart.tsx", () => ({ TimeSeriesChart: () => <div /> }));
vi.mock("../WeightPredictionSummary.tsx", () => ({ WeightPredictionSummary: () => <div /> }));

vi.mock("../../lib/trpc.ts", () => {
  function queryResult(data: unknown = []) {
    return {
      data,
      isLoading: false,
      isPending: false,
      isError: false,
      isSuccess: true,
      error: null,
    };
  }

  function recordQuery(name: string, data: unknown = []) {
    return {
      useQuery: (input?: unknown) => {
        state.queryCalls.push({ name, input });
        return queryResult(data);
      },
    };
  }

  const correlationMetrics = [
    { id: "protein", label: "Protein", unit: "g", domain: "nutrition", description: "Protein" },
    {
      id: "hrv",
      label: "Heart Rate Variability",
      unit: "ms",
      domain: "recovery",
      description: "Heart Rate Variability",
    },
  ];

  const bodyTrend = {
    avg_resting_hr: null,
    latest_resting_hr: null,
    stddev_resting_hr: null,
    healthStatus: [],
    baselineRelative: [],
  };

  return {
    trpc: {
      useUtils: () => ({
        journal: { entries: { invalidate: vi.fn() } },
      }),
      behaviorImpact: {
        impactSummary: recordQuery("behaviorImpact.impactSummary"),
      },
      bodyAnalytics: {
        recomposition: recordQuery("bodyAnalytics.recomposition"),
        weightOverview: recordQuery("bodyAnalytics.weightOverview", {
          smoothedWeight: [],
          prediction: null,
          recomposition: [],
          healthStatus: [],
          baselineRelative: [],
        }),
      },
      correlation: {
        computeV2: recordQuery("correlation.computeV2", null),
        metrics: recordQuery("correlation.metrics", correlationMetrics),
        observations: recordQuery("correlation.observations", {
          items: [],
          totalCount: 0,
          nextCursor: null,
        }),
      },
      dailyMetrics: {
        hrvBaseline: recordQuery("dailyMetrics.hrvBaseline"),
        list: recordQuery("dailyMetrics.list"),
        trends: recordQuery("dailyMetrics.trends", bodyTrend),
      },
      insights: {
        compute: recordQuery("insights.compute"),
      },
      journal: {
        create: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }) },
        delete: { useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) },
        entries: recordQuery("journal.entries"),
        questions: recordQuery("journal.questions"),
        trends: recordQuery("journal.trends", emptyJournalTrendEvidence),
      },
      nutritionAnalytics: {
        adaptiveTdee: recordQuery("nutritionAnalytics.adaptiveTdee"),
        macroRatios: recordQuery("nutritionAnalytics.macroRatios"),
        micronutrientAdequacyV2: recordQuery("nutritionAnalytics.micronutrientAdequacyV2", {
          nutrients: [],
          dataQuality: {
            selectedWindowDays: 30,
            daysWithData: 0,
            usableDays: 0,
            overlapDays: 0,
            conflictDays: 0,
            completenessPercent: 0,
            sourceLabels: [],
            contributingSourceLabels: [],
            excludedSourceLabels: [],
          },
          professionalReview: null,
        }),
      },
      sleep: {
        latestStages: recordQuery("sleep.latestStages"),
        list: recordQuery("sleep.list"),
      },
      sleepNeed: {
        calculateV2: recordQuery("sleepNeed.calculateV2"),
        performance: recordQuery("sleepNeed.performance"),
      },
      stress: {
        scores: recordQuery("stress.scores"),
      },
      processing: {
        status: recordQuery("processing.status", {
          overallStatus: "ready",
          generatedAt: "2026-07-08T00:00:00.000Z",
          scope: { datasets: [] },
          datasets: [],
          operations: [],
        }),
        dismiss: { useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) },
      },
    },
  };
});

export function clearQueryCalls() {
  state.queryCalls.length = 0;
}

export function expectCallsContaining(calls: Array<{ name: string; input: unknown }>) {
  expect(state.queryCalls).toEqual(expect.arrayContaining(calls));
}

export function expectRegistryCovered(registryKey: keyof typeof SELECTED_RANGE_QUERY_REGISTRY) {
  const calledNames = new Set(state.queryCalls.map((call) => call.name));
  for (const queryName of SELECTED_RANGE_QUERY_REGISTRY[registryKey]) {
    expect(calledNames.has(queryName)).toBe(true);
  }
}

export function getCapturedRouteComponent(path: string): ComponentType | undefined {
  return state.routeComponents[path];
}

export function BodyHarness() {
  const [days, setDays] = useState<number | null>(30);
  const [BodyPage, setBodyPage] = useState<ComponentType | null>(null);

  useEffect(() => {
    void import("../../pages/BodyPage.tsx").then((mod) => setBodyPage(() => mod.BodyPage));
  }, []);

  if (!BodyPage) return null;
  return (
    <BodyDaysContext.Provider
      value={{
        days,
        description: "Recommended default: 30 days keeps recent body changes visible.",
        setDays,
      }}
    >
      <BodyPage />
    </BodyDaysContext.Provider>
  );
}
