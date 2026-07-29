import { formatDateYmd } from "@dofek/format/format";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";
import {
  createProcessingStatusStoryLink,
  seedReadyProcessingStatus,
} from "./processing-status-story-fixture";
import RecoveryScreen from "./recovery";

function localDateString(dayOffset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  return formatDateYmd(date);
}

function buildTrendDates(count: number): string[] {
  return Array.from({ length: count }, (_, index) => localDateString(index - (count - 1)));
}

function createSeededProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const endDate = localDateString();
  const trendDates = buildTrendDates(14);
  const readinessComponents = {
    hrvScore: 84,
    restingHrScore: 78,
    sleepScore: 88,
    respiratoryRateScore: 74,
  };
  const readinessWeights = { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 };

  const processingStatus = seedReadyProcessingStatus(queryClient, [
    "activity",
    "sleep",
    "recovery",
  ]);

  queryClient.setQueryData(
    [["mobileDashboard", "recovery"], { input: { days: 30, endDate }, type: "query" }],
    {
      hrvVariability: trendDates.map((date, index) => ({
        date,
        hrv: 48 + Math.sin(index / 2) * 8,
        rollingCoefficientOfVariation: 0.12,
        rollingMean: 52,
      })),
      hrvBaseline: trendDates.map((date, index) => ({
        date,
        resting_hr: 52 + (index % 3),
        resting_hr_mean_7d: 53,
      })),
      readinessScore: trendDates.map((date, index) => ({
        date,
        readinessScore: 68 + (index % 5) * 4,
        components: readinessComponents,
        weights: readinessWeights,
      })),
      stress: {
        daily: trendDates.map((date, index) => ({
          date,
          stressScore: 28 + (index % 4) * 6,
        })),
        weekly: [],
        latestScore: 34,
        trend: "stable",
      },
      trends: {
        latest_spo2: 97.2,
        latest_skin_temp: 33.8,
      },
      dailyMetrics: trendDates.map((date, index) => ({
        date,
        steps: 7200 + index * 180,
        spo2_avg: 97 + (index % 2) * 0.2,
        skin_temp_c: 33.6 + (index % 3) * 0.1,
      })),
      weight: trendDates.map((date, index) => ({
        date,
        weight_kg: 74.2 - index * 0.05,
      })),
      weightPrediction: {
        ratePerWeek: -0.2,
        rateConfidence: 0.72,
        impliedDailyCalories: -220,
        periodDeltas: { days7: -0.15, days14: -0.28, days30: -0.55 },
        goal: { targetWeightKg: 72.5, targetDate: localDateString(60) },
        projectionLine: [],
      },
      healthStatus: [],
      healthspan: {
        healthspanScore: 84,
        yearsDelta: 1.8,
        metrics: [],
        history: [],
        trend: "improving",
      },
    },
  );

  return { processingStatus, queryClient };
}

function MockProviders({ children }: { children: React.ReactNode }) {
  const { queryClient, trpcClient } = useMemo(() => {
    const seededProviders = createSeededProviders();
    return {
      ...seededProviders,
      trpcClient: trpc.createClient({
        links: [createProcessingStatusStoryLink(seededProviders.processingStatus)],
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
  title: "Pages/Recovery",
  component: RecoveryScreen,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <MockProviders>
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
