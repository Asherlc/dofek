import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";

export const nutritionAnalyticsStoryData = {
  adaptiveTdee: {
    estimatedTdee: 2_250,
    confidence: 0.82,
    dataPoints: 30,
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

export type NutritionAnalyticsStoryScenario = "available" | "error";

function createStoryObservable(
  path: string,
  scenario: NutritionAnalyticsStoryScenario,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (scenario === "error" && path.startsWith("nutritionAnalytics.")) {
        observer.error?.(
          TRPCClientError.from<AppRouter>(new Error("Body measurements are unavailable.")),
        );
        return { unsubscribe: () => {} };
      }

      let data: unknown;
      if (path === "nutritionAnalytics.adaptiveTdee") {
        data = nutritionAnalyticsStoryData.adaptiveTdee;
      } else if (path === "nutritionAnalytics.macroRatios") {
        data = nutritionAnalyticsStoryData.macroRatios;
      } else if (path === "nutritionAnalytics.micronutrientAdequacyV2") {
        data = nutritionAnalyticsStoryData.micronutrientAdequacyV2;
      } else {
        observer.error?.(
          TRPCClientError.from<AppRouter>(new Error(`Unhandled Storybook tRPC path: ${path}`)),
        );
        return { unsubscribe: () => {} };
      }

      observer.next?.({ result: { data } });
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

export function createNutritionAnalyticsStoryLink(
  scenario: NutritionAnalyticsStoryScenario = "available",
): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createStoryObservable(op.path, scenario);
}
