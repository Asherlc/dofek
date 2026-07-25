import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import NutritionAnalyticsScreen from "./nutrition-analytics";
import { createNutritionAnalyticsStoryLink } from "./nutrition-analytics-story-link";

function NutritionAnalyticsStoryFrame() {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  );
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createNutritionAnalyticsStoryLink()] }),
    [],
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
  render: () => <NutritionAnalyticsStoryFrame />,
};
