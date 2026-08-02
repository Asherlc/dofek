import { formatDateYmd } from "@dofek/format/format";
import { PROVIDER_GUIDE_SETTINGS_KEY } from "@dofek/onboarding/provider-guide";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MISSING_PREVIOUS_NIGHT_MESSAGE } from "dofek-server/sleep-need-contract";
import { type ReactNode, useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";
import {
  createProcessingStatusStoryLink,
  seedReadyProcessingStatus,
} from "./_processing-status-story-fixture";
import TodayScreen from "./index";

function localDateString(dayOffset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  return formatDateYmd(date);
}

function createSeededProviders(sleepDataUnavailable: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });

  const todayDate = localDateString();

  const processingStatus = seedReadyProcessingStatus(queryClient, [
    "activity",
    "sleep",
    "recovery",
    "training",
    "body",
  ]);

  queryClient.setQueryData(
    [["mobileDashboard", "dashboardV2"], { input: { endDate: todayDate }, type: "query" }],
    {
      readiness: {
        score: 82,
        date: todayDate,
        components: {
          hrvScore: 84,
          restingHrScore: 78,
          sleepScore: 88,
          respiratoryRateScore: 74,
        },
        weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
      },
      sleep: {
        lastNight: sleepDataUnavailable
          ? null
          : {
              date: localDateString(-1),
              durationMinutes: 456,
              deepPct: 21,
              remPct: 24,
              lightPct: 47,
              awakePct: 8,
              stagingAvailable: true,
            },
        sleepDebt: sleepDataUnavailable ? 0 : 18,
      },
      strain: {
        dailyStrain: 11.8,
        acuteLoad: 360,
        chronicLoad: 395,
        workloadRatio: 0.91,
        date: todayDate,
      },
      sleepNeed: sleepDataUnavailable
        ? {
            availability: "missing_previous_night",
            epistemicStatus: { kind: "unavailable", label: "Unavailable" },
            message: MISSING_PREVIOUS_NIGHT_MESSAGE,
          }
        : {
            availability: "available",
            epistemicStatus: { kind: "estimated", label: "Estimated" },
            baselineMinutes: 480,
            strainDebtMinutes: 16,
            accumulatedDebtMinutes: 28,
            debtRecoveryMinutes: 7,
            totalNeedMinutes: 503,
            estimateMetadata: {
              basis: "personalized_high_hrv_average",
              baselineQualifyingNightCount: 12,
              debtObservedNightCount: 11,
              methodVersion: "sleep-need-heuristic-v1",
              uncertainty: "not_established",
              valueQualifier: "About",
              summaryLabel: "Heuristic estimate",
              componentLabels: {
                baseline: "Baseline estimate",
                strainDebt: "Previous-day load adjustment",
                debtRecovery: "Debt recovery",
              },
              basisLabel:
                "Baseline uses the average of 12 qualifying nights followed by at-or-above-median heart rate variability.",
              coverageLabel:
                "Sleep-debt input uses 11 observed nights from the model's recent-night window.",
              methodLabel: "Method: sleep-need-heuristic-v1",
              uncertaintyLabel: "Uncertainty: not established",
              limitationLabel:
                "This is a descriptive heuristic estimate, not a sleep recommendation. Its uncertainty has not been established.",
            },
            recentNights: [],
          },
      anomalies: { anomalies: [], checkedMetrics: [] },
      latestDate: todayDate,
    },
  );

  queryClient.setQueryData(
    [["todayPlan", "get"], { input: { endDate: todayDate }, type: "query" }],
    {
      status: "ready",
      epistemicStatus: { kind: "suggested", label: "Suggested" },
      date: todayDate,
      action: {
        id: "strain_target",
        title: "Train hard today — aim for 16.2 strain",
        summary: "Recovery is strong (82). Push for a high-strain day to build fitness.",
        zone: "Push",
      },
      supportingFacts: sleepDataUnavailable
        ? [
            { label: "Recovery", value: "82/100" },
            { label: "Recent-to-baseline workload ratio", value: "0.91" },
          ]
        : [
            { label: "Recovery", value: "82/100" },
            { label: "Sleep performance", value: "88 (Good)" },
          ],
      caveats: sleepDataUnavailable
        ? [
            "Sleep performance was unavailable, so this plan uses recovery and recent workload instead.",
          ]
        : [],
      confidence: sleepDataUnavailable ? "moderate" : "high",
      freshness: {
        recoveryDate: todayDate,
        sleepDate: sleepDataUnavailable ? null : localDateString(-1),
      },
      missingInputs: sleepDataUnavailable ? ["sleep"] : [],
    },
  );

  queryClient.setQueryData([["providerGuide", "status"], { type: "query" }], {
    dismissed: true,
  });

  queryClient.setQueryData(
    [["anomalyDetection", "check"], { input: { endDate: todayDate }, type: "query" }],
    { anomalies: [], checkedMetrics: [] },
  );

  queryClient.setQueryData(
    [["recovery", "readinessScore"], { input: { days: 30, endDate: todayDate }, type: "query" }],
    [
      {
        date: todayDate,
        readinessScore: 82,
      },
    ],
  );

  queryClient.setQueryData(
    [["recovery", "sleepAnalytics"], { input: { days: 30 }, type: "query" }],
    {
      nightly: [],
      sleepDebt: 0,
    },
  );

  queryClient.setQueryData(
    [["recovery", "workloadRatio"], { input: { days: 30, endDate: todayDate }, type: "query" }],
    {
      context: {
        label: "Recent-to-baseline workload ratio",
        description:
          "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
        recentDays: 7,
        baselineDays: 28,
      },
      displayedStrain: 11.8,
      displayedDate: todayDate,
      timeSeries: [
        {
          date: todayDate,
          dailyLoad: 410,
          strain: 11.8,
          acuteLoad: 360,
          chronicLoad: 395,
          workloadRatio: 0.91,
        },
      ],
    },
  );

  queryClient.setQueryData(
    [["dailyMetrics", "trends"], { input: { days: 30, endDate: todayDate }, type: "query" }],
    { latest_date: todayDate },
  );

  queryClient.setQueryData(
    [["sleepNeed", "calculate"], { input: { endDate: todayDate }, type: "query" }],
    null,
  );

  queryClient.setQueryData(
    [["anomalyDetection", "check"], { input: { endDate: todayDate }, type: "query" }],
    { anomalies: [] },
  );

  queryClient.setQueryData(
    [["sync", "providers"], { type: "query" }],
    [
      {
        id: "apple_health",
        name: "Apple Health",
        authType: "none",
        authorized: true,
        lastSyncedAt: new Date().toISOString(),
        importOnly: false,
        needsReauth: false,
      },
      {
        id: "whoop",
        name: "WHOOP",
        authType: "custom:whoop",
        authorized: true,
        lastSyncedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
        importOnly: false,
        needsReauth: false,
      },
    ],
  );

  queryClient.setQueryData(
    [["settings", "get"], { input: { key: PROVIDER_GUIDE_SETTINGS_KEY }, type: "query" }],
    { key: PROVIDER_GUIDE_SETTINGS_KEY, value: true },
  );

  return { processingStatus, queryClient };
}

function MockProviders({
  children,
  sleepDataUnavailable,
}: {
  children: ReactNode;
  sleepDataUnavailable: boolean;
}) {
  const { queryClient, trpcClient } = useMemo(() => {
    const seededProviders = createSeededProviders(sleepDataUnavailable);
    return {
      ...seededProviders,
      trpcClient: trpc.createClient({
        links: [createProcessingStatusStoryLink(seededProviders.processingStatus)],
      }),
    };
  }, [sleepDataUnavailable]);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Home",
  component: TodayScreen,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story, context) => (
      <MockProviders sleepDataUnavailable={context.parameters.sleepDataUnavailable === true}>
        <View style={{ minHeight: 1200, backgroundColor: colors.background }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
} satisfies Meta<typeof TodayScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SleepDataNeeded: Story = {
  parameters: {
    sleepDataUnavailable: true,
  },
};
