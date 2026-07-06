import type {
  SmoothedWeightRow,
  WeightPrediction,
} from "../../../server/src/routers/body-analytics.ts";

/**
 * When regression-based rate is unavailable, fall back to the latest weekly
 * change from smoothed weight — the same signal used by the trend chart bars.
 */
export function enrichWeightPrediction(
  prediction: WeightPrediction,
  smoothedWeight: SmoothedWeightRow[],
): WeightPrediction {
  if (prediction.ratePerWeek != null) return prediction;

  const latestWeeklyChange = [...smoothedWeight]
    .reverse()
    .find((row) => row.weeklyChange != null)?.weeklyChange;
  if (latestWeeklyChange == null) return prediction;

  return {
    ...prediction,
    ratePerWeek: latestWeeklyChange,
    impliedDailyCalories: Math.round(((latestWeeklyChange / 7) * 7700 * 10) / 10),
  };
}
