import { PROVIDER_GUIDE_SETTINGS_KEY } from "@dofek/onboarding/provider-guide";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { type ReactNode, useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";
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
    null,
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

  return { queryClient };
}

function MockProviders({ children }: { children: ReactNode }) {
  const { queryClient, trpcClient } = useMemo(() => {
    const seededProviders = createSeededProviders();
    return {
      ...seededProviders,
      trpcClient: trpc.createClient({
        links: [httpBatchLink({ url: "http://127.0.0.1/storybook-trpc" })],
      }),
    };
  }, []);

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
    (Story) => (
      <MockProviders>
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
