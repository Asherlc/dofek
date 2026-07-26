import { formatDateYmd } from "@dofek/format/format";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { View } from "react-native";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";
import FoodScreen from "./food";

function localDateString(dayOffset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  return formatDateYmd(date);
}

function createSeededProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const todayDate = localDateString();

  queryClient.setQueryData([["food", "byDate"], { input: { date: todayDate }, type: "query" }], {
    entries: [
      {
        id: "food-1",
        food_name: "Overnight oats",
        food_description: "1 cup with berries and almond butter",
        meal: "breakfast",
        calories: 420,
        protein_g: 16,
        carbs_g: 58,
        fat_g: 14,
      },
      {
        id: "food-2",
        food_name: "Protein shake",
        food_description: "Whey isolate, banana",
        meal: "breakfast",
        calories: 210,
        protein_g: 28,
        carbs_g: 18,
        fat_g: 3,
      },
      {
        id: "food-3",
        food_name: "Chicken rice bowl",
        food_description: "Grilled chicken, jasmine rice, broccoli",
        meal: "lunch",
        calories: 640,
        protein_g: 48,
        carbs_g: 62,
        fat_g: 16,
      },
      {
        id: "food-4",
        food_name: "Greek yogurt",
        food_description: "Plain, honey, walnuts",
        meal: "snack",
        calories: 240,
        protein_g: 18,
        carbs_g: 20,
        fat_g: 10,
      },
      {
        id: "food-5",
        food_name: "Salmon and quinoa",
        food_description: "Roasted salmon, quinoa, asparagus",
        meal: "dinner",
        calories: 710,
        protein_g: 52,
        carbs_g: 44,
        fat_g: 28,
      },
    ],
    summary: {
      calories: 2220,
      mealCalories: {
        breakfast: 630,
        lunch: 640,
        dinner: 710,
        snack: 240,
        other: 0,
      },
      calorieGoal: {
        target: 2200,
        remaining: 0,
        over: 20,
        progressPercentage: 100,
      },
      macros: {
        protein: { grams: 162, calories: 648, percentage: 29 },
        carbs: { grams: 202, calories: 808, percentage: 36 },
        fat: { grams: 71, calories: 639, percentage: 29 },
      },
    },
  });

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
  title: "Pages/Nutrition",
  component: FoodScreen,
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
} satisfies Meta<typeof FoodScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
