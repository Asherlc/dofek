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

function readString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(input: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = input?.[key];
  return typeof value === "number" ? value : undefined;
}

function createStages(date: string) {
  return (["awake", "light", "deep", "rem", "light"] as const).map((stage, index) => ({
    stage,
    started_at: `${date}T05:30:${String(index * 10).padStart(2, "0")}.000Z`,
    ended_at: `${date}T05:40:${String(index * 10).padStart(2, "0")}.000Z`,
    duration_seconds: 600,
  }));
}

const SLEEP_FIXTURE_NIGHTS = 90;
const SLEEP_CONSISTENCY_NIGHTS = 3;

function createStableNightly(dates: ReturnType<typeof createFixtureDates>): SleepNightlyRow[] {
  return Array.from({ length: SLEEP_FIXTURE_NIGHTS }, (_, index) =>
    createNight(dates.date(index - SLEEP_FIXTURE_NIGHTS + 1), index),
  );
}

function createStableConsistency(dates: ReturnType<typeof createFixtureDates>) {
  return Array.from({ length: SLEEP_CONSISTENCY_NIGHTS }, (_, index) => ({
    date: dates.date(index - SLEEP_CONSISTENCY_NIGHTS + 1),
    consistencyScore: 84 + index,
    bedtimeHour: 23.2,
    waketimeHour: 7.1,
    rollingBedtimeStddev: null,
    rollingWaketimeStddev: null,
  }));
}

function latestNights<T>(nights: readonly T[], days: number): T[] {
  return nights.slice(Math.max(0, nights.length - days));
}

function MockProviders({ children }: { children: React.ReactNode }) {
  const { queryClient, trpcClient } = useMemo(() => {
    const seededQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    const dates = createFixtureDates(new Date());
    const days = 30;
    const stableNightly = createStableNightly(dates);
    const stableConsistency = createStableConsistency(dates);
    const processingStatus = seedReadyProcessingStatus(seededQueryClient, ["sleep"]);

    seededQueryClient.setQueryData(
      [["recovery", "sleepAnalytics"], { input: { days }, type: "query" }],
      {
        nightly: latestNights(stableNightly, 7),
        averageSleepMinutes: 447,
        averageEfficiencyPercent: 92,
      },
    );
    seededQueryClient.setQueryData(
      [["recovery", "sleepConsistency"], { input: { days }, type: "query" }],
      stableConsistency,
    );
    seededQueryClient.setQueryData(
      [["sleep", "stagesByDate"], { input: undefined, type: "query" }],
      { date: dates.date(0), stages: createStages(dates.date(0)) },
    );

    return {
      queryClient: seededQueryClient,
      trpcClient: trpc.createClient({
        links: [
          createProcessingStatusStoryLink(processingStatus, {
            "sleep.stagesByDate": (input) => {
              const date = readString(input, "date") ?? dates.date(0);
              return { date, stages: createStages(date) };
            },
            "recovery.sleepAnalytics": (input) => ({
              nightly: latestNights(stableNightly, readNumber(input, "days") ?? days),
              averageSleepMinutes: 447,
              averageEfficiencyPercent: 92,
            }),
            "recovery.sleepConsistency": (input) =>
              latestNights(
                stableConsistency,
                Math.min(readNumber(input, "days") ?? days, SLEEP_CONSISTENCY_NIGHTS),
              ),
          }),
        ],
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
