import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";

function createStoryObservable(path: string): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      let data: unknown;
      if (path === "nutritionAnalytics.adaptiveTdee") {
        data = {
          estimatedTdee: 2_250,
          confidence: 0.82,
          dataPoints: 30,
          dailyData: [],
        };
      } else if (path === "nutritionAnalytics.macroRatios") {
        data = [
          {
            date: "2026-07-24",
            proteinPct: 30,
            carbsPct: 40,
            fatPct: 30,
            proteinPerKg: 1.7,
          },
        ];
      } else if (path === "nutritionAnalytics.micronutrientAdequacy") {
        data = [
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
        ];
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

export function createNutritionAnalyticsStoryLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createStoryObservable(op.path);
}
