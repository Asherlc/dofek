import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { View } from "react-native";
import {
  createNutritionAnalyticsStoryLink,
  nutritionAnalyticsStoryData,
} from "../.storybook/nutrition-analytics-story-link";
import NutritionAnalyticsScreen from "../app/nutrition-analytics";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

type NutritionAnalyticsStoryScenario = "available" | "error" | "stale-error" | "unavailable";

function NutritionAnalyticsStoryFrame({ scenario }: { scenario: NutritionAnalyticsStoryScenario }) {
  const queryClient = useMemo(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (scenario === "stale-error") {
      client.setQueryData(
        [["nutritionAnalytics", "adaptiveTdee"], { input: { days: 90 }, type: "query" }],
        nutritionAnalyticsStoryData.adaptiveTdee,
      );
      client.setQueryData(
        [["nutritionAnalytics", "macroRatios"], { input: { days: 90 }, type: "query" }],
        nutritionAnalyticsStoryData.macroRatios,
      );
      client.setQueryData(
        [["nutritionAnalytics", "micronutrientAdequacyV2"], { input: { days: 90 }, type: "query" }],
        nutritionAnalyticsStoryData.micronutrientAdequacyV2,
      );
    }
    return client;
  }, [scenario]);
  const trpcClient = useMemo(
    () =>
      trpc.createClient({
        links: [
          createNutritionAnalyticsStoryLink(
            scenario === "available" || scenario === "unavailable" ? scenario : "error",
          ),
        ],
      }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ minHeight: 900, backgroundColor: colors.background }}>
          <NutritionAnalyticsScreen />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/NutritionAnalytics",
  component: NutritionAnalyticsScreen,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof NutritionAnalyticsScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <NutritionAnalyticsStoryFrame scenario="available" />,
};

export const ConsolidatedError: Story = {
  render: () => <NutritionAnalyticsStoryFrame scenario="error" />,
};

export const TdeeUnavailable: Story = {
  render: () => <NutritionAnalyticsStoryFrame scenario="unavailable" />,
};

export const StaleDataWithRefreshError: Story = {
  render: () => <NutritionAnalyticsStoryFrame scenario="stale-error" />,
};
