import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import NutritionAnalyticsScreen from "./nutrition-analytics";

function createMockLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path);
}

function createMockObservable(path: string): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (path === "nutritionAnalytics.adaptiveTdee") {
        observer.next?.({
          result: {
            data: {
              estimatedTdee: 2_250,
              confidence: 0.82,
              dataPoints: 30,
              dailyData: [],
            },
          },
        });
      } else if (path === "nutritionAnalytics.macroRatios") {
        observer.next?.({
          result: {
            data: [
              {
                date: "2026-07-24",
                proteinPct: 30,
                carbsPct: 40,
                fatPct: 30,
                proteinPerKg: 1.7,
              },
            ],
          },
        });
      } else if (path === "nutritionAnalytics.micronutrientAdequacy") {
        observer.next?.({
          result: {
            data: [
              {
                nutrient: "Iron",
                unit: "mg",
                rda: 18,
                avgIntake: 15,
                percentRda: 83,
                daysTracked: 30,
              },
              {
                nutrient: "Vitamin C",
                unit: "mg",
                rda: 90,
                avgIntake: 102,
                percentRda: 113,
                daysTracked: 30,
              },
            ],
          },
        });
      }
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function NutritionAnalyticsStoryFrame() {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  );
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

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
