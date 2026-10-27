import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";

export const nutritionAnalyticsStoryData = {
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
          providerDailyTotalAverage: 0,
          supplementDailyAverage: 0,
          daysTracked: 30,
        },
        sourceBreakdown: [
          {
            providerId: "manual",
            sourceLabel: "Manual",
            intakeType: "itemized_food",
            dailyAverageContribution: 15,
            daysTracked: 30,
          },
        ],
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
          providerDailyTotalAverage: 0,
          supplementDailyAverage: 30,
          daysTracked: 30,
        },
        sourceBreakdown: [
          {
            providerId: "manual",
            sourceLabel: "Manual",
            intakeType: "itemized_food",
            dailyAverageContribution: 72,
            daysTracked: 30,
          },
          {
            providerId: "dofek",
            sourceLabel: "Dofek supplements",
            intakeType: "supplement",
            dailyAverageContribution: 30,
            daysTracked: 30,
          },
        ],
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
    dataQuality: {
      selectedWindowDays: 90,
      daysWithData: 60,
      usableDays: 58,
      overlapDays: 4,
      conflictDays: 2,
      completenessPercent: 64.4,
      sourceLabels: ["Cronometer", "Dofek supplements", "Manual"],
      contributingSourceLabels: ["Dofek supplements", "Manual"],
      excludedSourceLabels: ["Cronometer"],
    },
  },
} as const;

export type NutritionAnalyticsStoryScenario = "available" | "error" | "unavailable";

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
        data =
          scenario === "unavailable"
            ? nutritionAnalyticsStoryData.adaptiveTdeeUnavailable
            : nutritionAnalyticsStoryData.adaptiveTdee;
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
