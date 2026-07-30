import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { NutritionAnalyticsPage } from "./NutritionAnalyticsPage.tsx";

type NutritionAnalyticsScenario = "available" | "error" | "stale-error" | "unavailable";

const storyData = {
  adaptiveTdee: {
    status: "available",
    estimatedTdee: 2_250,
    estimateRange: { minimum: 2_180, maximum: 2_320 },
    unavailableReason: null,
    evidence: {
      selectedWindowDays: 90,
      fitWindowDays: 28,
      minimumCalorieDays: 20,
      observedDays: 90,
      calorieDays: 82,
      weightDays: 45,
      acceptedWindows: 30,
      excludedDays: {
        missingCalories: 6,
        sourceConflict: 2,
        lowerPrioritySources: 3,
      },
    },
    dailyData: [],
  },
  adaptiveTdeeUnavailable: {
    status: "unavailable",
    estimatedTdee: null,
    estimateRange: null,
    unavailableReason: "No body-weight measurements are available in the selected period.",
    evidence: {
      selectedWindowDays: 90,
      fitWindowDays: 28,
      minimumCalorieDays: 20,
      observedDays: 90,
      calorieDays: 90,
      weightDays: 0,
      acceptedWindows: 0,
      excludedDays: {
        missingCalories: 0,
        sourceConflict: 0,
        lowerPrioritySources: 0,
      },
    },
    dailyData: [],
  },
  macroRatios: [
    {
      date: "2026-07-24",
      proteinPct: 30,
      carbsPct: 40,
      fatPct: 30,
      proteinPerKg: 1.7,
    },
  ],
  micronutrientAdequacyV2: {
    nutrients: [
      {
        nutrientId: "iron",
        nutrient: "Iron",
        unit: "mg",
        intake: {
          totalDailyAverage: 15,
          foodDailyAverage: 15,
          supplementDailyAverage: 0,
          daysTracked: 30,
        },
        adequacy: {
          status: "below_daily_value",
          percentDailyValue: 83,
          message:
            "Average intake over recorded days is below the FDA Daily Value. This generic label reference is not a personalized deficiency assessment.",
          reference: { amount: 18 },
        },
        upperLimit: {
          status: "not_in_ruleset",
          message: "No upper-limit rule is included in this bounded ruleset.",
        },
        safetyStatus: "no_upper_limit_in_ruleset",
      },
      {
        nutrientId: "vitamin_c",
        nutrient: "Vitamin C",
        unit: "mg",
        intake: {
          totalDailyAverage: 102,
          foodDailyAverage: 72,
          supplementDailyAverage: 30,
          daysTracked: 30,
        },
        adequacy: {
          status: "at_or_above_daily_value",
          percentDailyValue: 113,
          message:
            "Average intake over recorded days meets or exceeds the FDA Daily Value. This generic label reference is not a personalized safety assessment.",
          reference: { amount: 90 },
        },
        upperLimit: {
          status: "within_limit",
          message: "Average intake over recorded days is below the included NIH adult upper limit.",
        },
        safetyStatus: "within_upper_limit",
      },
    ],
  },
} as const;

function createMockLink(scenario: NutritionAnalyticsScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path, scenario);
}

function createMockObservable(
  path: string,
  scenario: NutritionAnalyticsScenario,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (
        scenario !== "available" &&
        scenario !== "unavailable" &&
        path.startsWith("nutritionAnalytics.")
      ) {
        observer.error?.(
          TRPCClientError.from<AppRouter>(new Error("Body measurements are unavailable.")),
        );
        return { unsubscribe: () => {} };
      }

      if (path === "nutritionAnalytics.adaptiveTdee") {
        observer.next?.({
          result: {
            data:
              scenario === "unavailable"
                ? storyData.adaptiveTdeeUnavailable
                : storyData.adaptiveTdee,
          },
        });
      } else if (path === "nutritionAnalytics.macroRatios") {
        observer.next?.({ result: { data: storyData.macroRatios } });
      } else if (path === "nutritionAnalytics.micronutrientAdequacyV2") {
        observer.next?.({ result: { data: storyData.micronutrientAdequacyV2 } });
      } else {
        observer.error?.(
          TRPCClientError.from<AppRouter>(
            new Error(`Unhandled nutrition analytics story tRPC path: ${path}`),
          ),
        );
        return { unsubscribe: () => {} };
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

function NutritionAnalyticsStoryFrame({ scenario }: { scenario: NutritionAnalyticsScenario }) {
  const queryClient = useMemo(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (scenario === "stale-error") {
      client.setQueryData(
        [["nutritionAnalytics", "adaptiveTdee"], { input: { days: 90 }, type: "query" }],
        storyData.adaptiveTdee,
      );
      client.setQueryData(
        [["nutritionAnalytics", "macroRatios"], { input: { days: 30 }, type: "query" }],
        storyData.macroRatios,
      );
      client.setQueryData(
        [["nutritionAnalytics", "micronutrientAdequacyV2"], { input: { days: 30 }, type: "query" }],
        storyData.micronutrientAdequacyV2,
      );
    }
    return client;
  }, [scenario]);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: NutritionAnalyticsPage });
    return createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  }, []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/NutritionAnalytics",
  component: NutritionAnalyticsPage,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof NutritionAnalyticsPage>;

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
