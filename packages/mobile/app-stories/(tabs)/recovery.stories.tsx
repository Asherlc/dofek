import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import { mobileRecoveryFixtureSchema } from "dofek-server/mobile-dashboard-contracts";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import RecoveryScreen from "../../app/(tabs)/recovery";
import { createFixtureDates } from "../../app-fixtures/(tabs)/fixture-dates";
import {
  createProcessingStatusStoryLink,
  seedReadyProcessingStatus,
} from "../../app-fixtures/(tabs)/processing-status-story-fixture";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";

function createRecoveryErrorStoryLink(recoveryUnavailable: boolean): TRPCLink<AppRouter> {
  return () =>
    ({ op, next }) => {
      if (!recoveryUnavailable || op.path !== "mobileDashboard.recovery") {
        return next(op);
      }

      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          observer.error?.(
            TRPCClientError.from<AppRouter>(
              new Error("Recovery analytics are temporarily unavailable."),
            ),
          );
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
}

function createSeededProviders(healthspanInsufficient = false, recoveryUnavailable = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const dates = createFixtureDates(new Date());
  const endDate = dates.date();
  const trendDates = Array.from({ length: 14 }, (_, index) => dates.date(index - 13));
  const readinessComponents = {
    hrvScore: 84,
    restingHrScore: 78,
    sleepScore: 88,
    respiratoryRateScore: 74,
  };
  const readinessWeights = { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 };
  const stressDaily = trendDates.map((date, index) => ({
    date,
    stressScore: 1 + (index % 4) * 0.3,
    hrvDeviation: null,
    restingHrDeviation: null,
    sleepEfficiency: 88,
  }));
  const processingStatus = seedReadyProcessingStatus(queryClient, [
    "activity",
    "sleep",
    "recovery",
  ]);
  const healthspan = healthspanInsufficient
    ? {
        healthspanScore: null,
        yearsDelta: null,
        metrics: [],
        history: [],
        trend: null,
        availability: {
          status: "insufficient_data" as const,
          availableMetricCount: 2,
          requiredMetricCount: 3 as const,
          missingMetricLabels: ["VO2 Max", "Daily Steps"],
          summary: "2 of 3 required Healthspan metrics are available.",
          nextCondition:
            "The score becomes available after 1 more supported metric syncs successfully.",
        },
      }
    : {
        healthspanScore: 84,
        yearsDelta: 1.8,
        metrics: [
          {
            name: "Sleep Duration",
            value: 450,
            unit: "min/night",
            score: 100,
            status: "excellent" as const,
            yearsDelta: -2.5,
          },
          {
            name: "Daily Steps",
            value: 9200,
            unit: "steps/day",
            score: 85,
            status: "excellent" as const,
            yearsDelta: -1.75,
          },
          {
            name: "Resting Heart Rate",
            value: 54,
            unit: "bpm",
            score: 90,
            status: "excellent" as const,
            yearsDelta: -2,
          },
        ],
        history: [
          { weekStart: "2026-03-02", score: 73 },
          { weekStart: "2026-03-09", score: 75 },
          { weekStart: "2026-03-16", score: 78 },
          { weekStart: "2026-03-23", score: 80 },
        ],
        trend: "improving" as const,
        availability: {
          status: "available" as const,
          availableMetricCount: 3,
          requiredMetricCount: 3 as const,
          missingMetricLabels: [],
          summary: "3 of 3 required Healthspan metrics are available.",
          nextCondition: null,
        },
      };
  const fixture = mobileRecoveryFixtureSchema.parse({
    input: { days: 30, endDate },
    data: {
      hrvVariability: trendDates.map((date, index) => ({
        date,
        hrv: 48 + Math.sin(index / 2) * 8,
        rollingCoefficientOfVariation: 0.12,
        rollingMean: 52,
      })),
      hrvBaseline: trendDates.map((date, index) => ({
        date,
        hrv: 48 + Math.sin(index / 2) * 8,
        resting_hr: 52 + (index % 3),
        mean_60d: 50,
        sd_60d: 4,
        mean_7d: 52,
        resting_hr_mean_7d: 53,
      })),
      readinessScore: trendDates.map((date, index) => ({
        date,
        readinessScore: 68 + (index % 5) * 4,
        components: readinessComponents,
        weights: readinessWeights,
      })),
      stress: {
        daily: stressDaily,
        weekly: [],
        latestScore: stressDaily.at(-1)?.stressScore ?? null,
        trend: "stable",
      },
      trends: {
        latest_spo2: 97.2,
        latest_skin_temp: 33.8,
      },
      dailyMetrics: trendDates.map((date, index) => ({
        date,
        user_id: "00000000-0000-0000-0000-000000000000",
        hrv: 48 + Math.sin(index / 2) * 8,
        spo2_avg: 97 + (index % 2) * 0.2,
        respiratory_rate_avg: 14 + (index % 3) * 0.1,
        skin_temp_c: 33.6 + (index % 3) * 0.1,
        steps: 7200 + index * 180,
        distance_km: 5.4 + index * 0.1,
        flights_climbed: 6 + (index % 3),
        exercise_minutes: 45 + index,
        stand_hours: 10 + (index % 3),
        walking_speed: 1.3,
        source_providers: ["apple_health"],
      })),
      weight: trendDates.map((date, index) => ({
        date,
        rawWeight: 74.2 - index * 0.05,
        rawWeightStatus: { kind: "observed", label: "Observed" },
        smoothedWeight: 74.2 - index * 0.05,
        smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
        weeklyChange: -0.2,
        interpolated: false,
      })),
      bodyFatTrend: trendDates.map((date, index) => ({
        date,
        rawBodyFatPct: 24.2 - index * 0.04,
        rawBodyFatStatus: { kind: "observed", label: "Observed" },
        smoothedBodyFatPct: 24.2 - index * 0.04,
        smoothedBodyFatStatus: { kind: "estimated", label: "Estimated" },
        weeklyChange: -0.28,
        interpolated: false,
      })),
      decisionContext: {
        latestMeasurement: {
          date: endDate,
          recordedAt: `${endDate}T15:00:00.000Z`,
          recordedAtLocal: `${endDate} 08:00:00`,
          weightKg: 73.55,
          providerId: "withings",
          sourceName: "Body+",
        },
        trendWeight: {
          smoothing: "ewma",
          alpha: 0.1,
          gapHandling: "linear_interpolation",
          invalidWeightHandling: "exclude_non_positive",
          outlierHandling: "retain",
        },
        variation: {
          status: "available",
          observations: 12,
          minimumObservations: 8,
          maximumObservations: 30,
          method: "tukey_inner_fence",
          lowerResidualKg: -0.4,
          upperResidualKg: 0.6,
          outliersIncluded: true,
        },
      },
      weightPrediction: {
        ratePerWeek: -0.2,
        rateConfidence: 0.72,
        impliedDailyCalories: -220,
        periodDeltas: { days7: -0.15, days14: -0.28, days30: -0.55 },
        goal: {
          goalWeightKg: 72.5,
          remainingKg: 1.1,
          estimatedDate: dates.date(60),
          daysRemaining: 60,
        },
        projectionLine: [],
      },
      bodyFatPrediction: {
        ratePerWeek: -0.28,
        rateConfidence: 0.72,
        periodDeltas: { days7: -0.2, days14: -0.42, days30: -0.86 },
        projectionLine: [],
      },
      baselineRelative: [
        {
          metric: "hrv",
          label: "Heart Rate Variability (HRV)",
          value: 56,
          baseline: {
            windowDays: 30,
            mean: 50,
            standardDeviation: 4,
            zScore: 1.5,
            sampleCount: 27,
            coverage: 0.9,
          },
          comparison: {
            recentDays: 7,
            baselineDays: 28,
            recentMean: 54,
            baselineMean: 50,
            delta: 4,
            direction: "increasing",
          },
        },
        {
          metric: "resting_heart_rate",
          label: "Resting Heart Rate",
          value: 52,
          baseline: {
            windowDays: 30,
            mean: 54,
            standardDeviation: 2,
            zScore: -1,
            sampleCount: 28,
            coverage: 28 / 30,
          },
          comparison: {
            recentDays: 7,
            baselineDays: 28,
            recentMean: 52,
            baselineMean: 54,
            delta: -2,
            direction: "decreasing",
          },
        },
        {
          metric: "respiratory_rate",
          label: "Respiratory Rate",
          value: 14,
          baseline: {
            windowDays: 30,
            mean: 14.5,
            standardDeviation: 0.5,
            zScore: -1,
            sampleCount: 26,
            coverage: 26 / 30,
          },
          comparison: {
            recentDays: 7,
            baselineDays: 28,
            recentMean: 14,
            baselineMean: 14.5,
            delta: -0.5,
            direction: "decreasing",
          },
        },
        {
          metric: "sleep_efficiency",
          label: "Sleep Efficiency",
          value: 90,
          baseline: {
            windowDays: 30,
            mean: 86,
            standardDeviation: 3,
            zScore: 1.33,
            sampleCount: 29,
            coverage: 29 / 30,
          },
          comparison: {
            recentDays: 7,
            baselineDays: 28,
            recentMean: 89,
            baselineMean: 86,
            delta: 3,
            direction: "increasing",
          },
        },
      ],
      healthStatus: [],
      healthspan,
    },
  });

  if (!recoveryUnavailable) {
    queryClient.setQueryData(
      [["mobileDashboard", "recovery"], { input: { days: 30, endDate }, type: "query" }],
      fixture.data,
    );
  }

  return { processingStatus, queryClient };
}

function MockProviders({
  children,
  healthspanInsufficient = false,
  recoveryUnavailable = false,
}: {
  children: React.ReactNode;
  healthspanInsufficient?: boolean;
  recoveryUnavailable?: boolean;
}) {
  const { queryClient, trpcClient } = useMemo(() => {
    const seededProviders = createSeededProviders(healthspanInsufficient, recoveryUnavailable);
    return {
      ...seededProviders,
      trpcClient: trpc.createClient({
        links: [
          createRecoveryErrorStoryLink(recoveryUnavailable),
          createProcessingStatusStoryLink(seededProviders.processingStatus),
        ],
      }),
    };
  }, [healthspanInsufficient, recoveryUnavailable]);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Recovery",
  component: RecoveryScreen,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story, context) => (
      <MockProviders
        healthspanInsufficient={context.parameters.healthspanInsufficient === true}
        recoveryUnavailable={context.parameters.recoveryUnavailable === true}
      >
        <View style={{ minHeight: 1400, backgroundColor: colors.background }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
} satisfies Meta<typeof RecoveryScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const InsufficientHealthspanData: Story = {
  parameters: {
    healthspanInsufficient: true,
  },
};

export const RecoveryUnavailable: Story = {
  parameters: {
    recoveryUnavailable: true,
  },
  tags: ["review-scenario-error"],
};
