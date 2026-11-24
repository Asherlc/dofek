import { formatDateYmd } from "@dofek/format/format";
import { PROVIDER_GUIDE_SETTINGS_KEY } from "@dofek/onboarding/provider-guide";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { View } from "react-native";
import OverviewScreen from "../../app/(tabs)/index";
import { overviewEvidenceFixture } from "../../app-fixtures/(tabs)/overview-evidence";
import {
  createProcessingStatusStoryLink,
  seedReadyProcessingStatus,
} from "../../app-fixtures/(tabs)/processing-status-story-fixture";
import {
  screenshotConnectedProviders,
  screenshotOverviewEvidence,
} from "../../app-fixtures/(tabs)/screenshot-profile";
import { overviewDays } from "../../components/OverviewEvidence";
import { statusRowWithoutBadgeFirst } from "../../components/training-progression-fixture";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";

function localDateString(dayOffset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  return formatDateYmd(date);
}

function createSeededProviders({
  sleepDataUnavailable,
  appStoreScreenshot,
}: {
  sleepDataUnavailable: boolean;
  appStoreScreenshot: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });

  const todayDate = localDateString();
  const evidence = appStoreScreenshot ? screenshotOverviewEvidence : overviewEvidenceFixture;

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
      },
      anomalies: { anomalies: [], checkedMetrics: [] },
      latestDate: todayDate,
      summaryDateContext: { effectiveDate: todayDate, timezone: "America/Los_Angeles" },
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
    [["recovery", "sleepAnalytics"], { input: { days: 30 }, type: "query" }],
    {
      nightly: [],
    },
  );

  queryClient.setQueryData(
    [["recovery", "workloadRatio"], { input: { days: 30, endDate: todayDate }, type: "query" }],
    {
      context: {
        label: "Recent-to-baseline workload ratio",
        description:
          "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days.",
        recentDays: 7,
        baselineDays: 28,
      },
      displayedDate: todayDate,
      timeSeries: [
        {
          date: todayDate,
          dailyLoad: 410,
          acuteLoad: 360,
          chronicLoad: 395,
          workloadRatio: 0.91,
        },
      ],
    },
  );

  const overviewInput = { days: overviewDays, endDate: todayDate };
  queryClient.setQueryData(
    [["dailyMetrics", "trends"], { input: overviewInput, type: "query" }],
    evidence.trends.data,
  );
  queryClient.setQueryData(
    [["dailyMetrics", "hrvBaseline"], { input: overviewInput, type: "query" }],
    evidence.heartRate.data,
  );
  queryClient.setQueryData(
    [["insights", "compute"], { input: overviewInput, type: "query" }],
    evidence.insights.data,
  );

  queryClient.setQueryData(
    [["trainingProgression", "strength"], { type: "query" }],
    statusRowWithoutBadgeFirst,
  );

  queryClient.setQueryData(
    [["anomalyDetection", "check"], { input: { endDate: todayDate }, type: "query" }],
    { anomalies: [] },
  );

  queryClient.setQueryData(
    [["sync", "providers"], { type: "query" }],
    appStoreScreenshot
      ? screenshotConnectedProviders
      : [
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
  appStoreScreenshot,
}: {
  children: ReactNode;
  sleepDataUnavailable: boolean;
  appStoreScreenshot: boolean;
}) {
  const { queryClient, trpcClient } = useMemo(() => {
    const seededProviders = createSeededProviders({ sleepDataUnavailable, appStoreScreenshot });
    return {
      ...seededProviders,
      trpcClient: trpc.createClient({
        links: [createProcessingStatusStoryLink(seededProviders.processingStatus)],
      }),
    };
  }, [sleepDataUnavailable, appStoreScreenshot]);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Overview",
  component: OverviewScreen,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story, context) => (
      <MockProviders
        sleepDataUnavailable={context.parameters.sleepDataUnavailable === true}
        appStoreScreenshot={context.parameters.appStoreScreenshot === true}
      >
        <View style={{ flex: 1, minHeight: "100%", backgroundColor: colors.background }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
} satisfies Meta<typeof OverviewScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SleepDataNeeded: Story = {
  parameters: {
    sleepDataUnavailable: true,
  },
};

export const AppStoreScreenshot: Story = {
  parameters: {
    appStoreScreenshot: true,
  },
};
