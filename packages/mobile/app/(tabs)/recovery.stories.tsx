import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { mobileRecoveryFixtureSchema } from "dofek-server/mobile-dashboard-contracts";
import { View } from "react-native";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";
import { createFixtureDates } from "./fixture-dates";
import RecoveryScreen from "./recovery";

function createSeededProviders() {
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
        smoothedWeight: 74.2 - index * 0.05,
        weeklyChange: -0.2,
        interpolated: false,
      })),
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
      healthStatus: [],
      healthspan: {
        healthspanScore: 84,
        yearsDelta: 1.8,
        metrics: [],
        history: [],
        trend: "improving",
      },
    },
  });

  queryClient.setQueryData(
    [["mobileDashboard", "recovery"], { input: { days: 30, endDate }, type: "query" }],
    fixture.data,
  );

  return { queryClient };
}

function MockProviders({ children }: { children: React.ReactNode }) {
  const { queryClient } = createSeededProviders();
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: "http://127.0.0.1/storybook-trpc" })],
  });

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
