import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import ExperimentsScreen from "./experiments";

type ExperimentScenario = "empty" | "active";

const metrics = [{ id: "hrv", label: "Heart Rate Variability", unit: "ms", domain: "recovery" }];

const activeExperiment = {
  id: "11111111-1111-4111-8111-111111111111",
  hypothesis: "Does earlier bedtime improve heart rate variability?",
  intervention: "Lights out by 10pm on weeknights",
  outcomeMetricId: "hrv",
  outcomeMetricLabel: "Heart Rate Variability",
  lagDays: 1,
  baselineDays: 7,
  interventionDays: 14,
  startDate: "2026-07-01",
  status: "active" as const,
  stoppedAt: null,
  createdAt: "2026-07-01T10:00:00.000Z",
  phase: "baseline",
  phaseLabel: "Baseline",
  schedule: {
    phase: "baseline",
    phaseLabel: "Baseline",
    baselineStartDate: "2026-07-01",
    baselineEndDate: "2026-07-07",
    interventionStartDate: "2026-07-08",
    interventionEndDate: "2026-07-21",
    dayInPhase: 3,
    daysRemainingInPhase: 5,
    scheduleSummary: "Day 3 of baseline (5 days remaining)",
  },
};

const activeExperimentAnalysis = {
  outcomeMetricId: "hrv",
  outcomeMetricLabel: "Heart Rate Variability",
  checkIns: [],
  annotations: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      label: "Travel",
      startedAt: "2026-07-03",
      endedAt: null,
      category: null,
      ongoing: false,
      notes: "Different time zone",
      createdAt: "2026-07-03T00:00:00.000Z",
    },
  ],
  analysis: {
    availability: "available",
    observations: [],
    coverage: {
      baseline: {
        expectedDayCount: 7,
        observedOutcomeDayCount: 5,
        missingOutcomeDayCount: 2,
        checkInCount: 0,
        adherenceCounts: { adherent: 0, partial: 0, not_adherent: 0, unknown: 0 },
      },
      intervention: {
        expectedDayCount: 14,
        observedOutcomeDayCount: 12,
        missingOutcomeDayCount: 2,
        checkInCount: 5,
        adherenceCounts: { adherent: 4, partial: 1, not_adherent: 0, unknown: 0 },
      },
    },
    effect: {
      baselineMean: 50,
      interventionMean: 55,
      differenceInMeans: 5,
      baselineSampleCount: 5,
      interventionSampleCount: 5,
    },
    uncertainty: {
      availability: "available",
      method: "circular_moving_block_bootstrap",
      level: 0.95,
      lower: 1,
      upper: 8,
      requestedReplicateCount: 2000,
      attemptedReplicateCount: 2000,
      validReplicateCount: 2000,
      blockLength: 2,
    },
    limitations: ["2 outcome days are missing during baseline."],
  },
};

function createMockLink(scenario: ExperimentScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path, scenario);
}

function createMockObservable(
  path: string,
  scenario: ExperimentScenario,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (path === "personalExperiments.metrics") {
        observer.next?.({ result: { data: metrics } });
        observer.complete?.();
        return { unsubscribe() {} };
      }
      if (path === "personalExperiments.list") {
        observer.next?.({
          result: { data: scenario === "active" ? [activeExperiment] : [] },
        });
        observer.complete?.();
        return { unsubscribe() {} };
      }
      if (path === "personalExperiments.analysis") {
        observer.next?.({ result: { data: activeExperimentAnalysis } });
        observer.complete?.();
        return { unsubscribe() {} };
      }
      observer.next?.({ result: { data: null } });
      observer.complete?.();
      return { unsubscribe() {} };
    },
  };
  return result;
}

function ExperimentsStoryFrame({ scenario }: { scenario: ExperimentScenario }) {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
    [],
  );
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <ExperimentsScreen />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/PersonalExperiments",
  component: ExperimentsScreen,
} satisfies Meta<typeof ExperimentsScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: () => <ExperimentsStoryFrame scenario="empty" />,
};

export const ActiveSchedule: Story = {
  render: () => <ExperimentsStoryFrame scenario="active" />,
};
