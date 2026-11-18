import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { View } from "react-native";
import SleepScreen from "../app/sleep";
import { createFixtureDates } from "../app-fixtures/(tabs)/fixture-dates";
import {
  createProcessingStatusStoryLink,
  seedReadyProcessingStatus,
} from "../app-fixtures/(tabs)/processing-status-story-fixture";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import type { SleepNightlyRow } from "../types/api";

const available = { status: "available" } as const;

function createNight(date: string, index: number): SleepNightlyRow {
  return {
    date,
    durationMinutes: 450 + index,
    sleepMinutes: 420 + index,
    deepPct: 18,
    remPct: 22,
    lightPct: 52,
    awakePct: 8,
    efficiency: 91 + (index % 5),
    stagingAvailable: true,
    rollingAvgDuration: 430,
    durationState: available,
    sleepState: available,
    stageState: available,
    startedAt: `${date}T05:30:00.000Z`,
    endedAt: `${date}T13:00:00.000Z`,
    localTimeContext: {
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -420,
      endUtcOffsetMinutes: -420,
      source: "provider_timezone",
    },
    providerId: "oura",
    sourceName: "Oura Ring",
    sourceProviders: ["oura"],
    selectedSessionId: `session-${date}`,
    overlappingSessions: [],
  };
}

function MockProviders({ children }: { children: React.ReactNode }) {
  const { queryClient, trpcClient } = useMemo(() => {
    const seededQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    const dates = createFixtureDates(new Date());
    const days = 30;
    const nightly = Array.from({ length: 7 }, (_, index) =>
      createNight(dates.date(index - 6), index),
    );
    const processingStatus = seedReadyProcessingStatus(seededQueryClient, ["sleep"]);

    seededQueryClient.setQueryData(
      [["recovery", "sleepAnalytics"], { input: { days }, type: "query" }],
      { nightly, averageSleepMinutes: 447, averageEfficiencyPercent: 92 },
    );
    seededQueryClient.setQueryData(
      [["recovery", "sleepConsistency"], { input: { days }, type: "query" }],
      Array.from({ length: 3 }, (_, index) => ({
        date: dates.date(index - 2),
        consistencyScore: 84 + index,
        bedtimeHour: 23.2,
        waketimeHour: 7.1,
      })),
    );
    seededQueryClient.setQueryData(
      [["sleep", "stagesByDate"], { input: undefined, type: "query" }],
      {
        date: dates.date(0),
        stages: ["awake", "light", "deep", "rem", "light"].map((stage, index) => ({
          stage,
          started_at: `${dates.date(0)}T05:30:${String(index * 10).padStart(2, "0")}.000Z`,
          ended_at: `${dates.date(0)}T05:40:${String(index * 10).padStart(2, "0")}.000Z`,
          duration_seconds: 600,
        })),
      },
    );

    return {
      queryClient: seededQueryClient,
      trpcClient: trpc.createClient({
        links: [createProcessingStatusStoryLink(processingStatus)],
      }),
    };
  }, []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

// The date controls keep one compact row (chevron, picker, chevron) at standard
// text size. When `useWindowDimensions().fontScale` exceeds one, the picker moves
// to its own line and both 44pt chevrons stay together on the line below. To
// inspect that variant, set iOS Accessibility → Display & Text Size → Larger Text
// to Extra Extra Large in Simulator while this story is open.
const meta = {
  title: "Pages/Sleep",
  component: SleepScreen,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <MockProviders>
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
} satisfies Meta<typeof SleepScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
