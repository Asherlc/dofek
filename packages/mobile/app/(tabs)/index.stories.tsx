import { ONBOARDING_SETTINGS_KEY } from "@dofek/onboarding/onboarding";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { View } from "react-native";
import TodayScreen from "./index";

function localDateString(dayOffset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  return date.toLocaleDateString("en-CA");
}

function createSeededProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });

  const todayDate = localDateString();
  const yesterdayDate = localDateString(-1);

  queryClient.setQueryData(
    [["recovery", "readinessScore"], { input: { days: 30, endDate: todayDate }, type: "query" }],
    [
      {
        date: todayDate,
        readinessScore: 82,
        components: {
          hrvScore: 86,
          restingHrScore: 78,
          sleepScore: 84,
          respiratoryRateScore: 80,
        },
      },
    ],
  );

  queryClient.setQueryData(
    [["recovery", "sleepAnalytics"], { input: { days: 30 }, type: "query" }],
    {
      nightly: [
        {
          date: yesterdayDate,
          durationMinutes: 462,
          deepPct: 18,
          remPct: 23,
          lightPct: 52,
          awakePct: 7,
        },
      ],
      sleepDebt: 32,
    },
  );

  queryClient.setQueryData(
    [["recovery", "workloadRatio"], { input: { days: 30, endDate: todayDate }, type: "query" }],
    {
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
    [["training", "nextWorkout"], { input: { endDate: todayDate }, type: "query" }],
    {
      generatedAt: new Date().toISOString(),
      recommendationType: "strength",
      title: "Strength Session",
      shortBlurb:
        "Prioritize a full-body lift today. Keep the effort controlled and leave a little in reserve.",
      readiness: { score: 82, level: "high" },
      rationale: [
        "Readiness score is 82/100 (high).",
        "Last 7 days: 1 strength and 3 cardio sessions.",
      ],
      details: [
        "Warm up 8-10 minutes, then train full-body exercises.",
        "Use 3-4 working sets per exercise in the 6-12 rep range.",
        "Stop 1-3 reps before failure on most sets.",
      ],
      strength: {
        focusMuscles: ["glutes", "hamstrings", "upper back"],
        split: "Full body",
        targetSets: "10-16 hard sets total",
        lastStrengthDaysAgo: 3,
      },
      cardio: null,
    },
  );

  queryClient.setQueryData(
    [["sleepNeed", "calculate"], { input: { endDate: todayDate }, type: "query" }],
    {
      baselineMinutes: 480,
      strainDebtMinutes: 24,
      accumulatedDebtMinutes: 128,
      totalNeedMinutes: 536,
      recentNights: [],
      canRecommend: true,
    },
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
    [["settings", "get"], { input: { key: ONBOARDING_SETTINGS_KEY }, type: "query" }],
    { key: ONBOARDING_SETTINGS_KEY, value: true },
  );

  return { queryClient };
}

function MockProviders({ children }: { children: ReactNode }) {
  const { queryClient } = createSeededProviders();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const meta = {
  title: "Pages/Home",
  component: TodayScreen,
  decorators: [
    (Story) => (
      <MockProviders>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
} satisfies Meta<typeof TodayScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
