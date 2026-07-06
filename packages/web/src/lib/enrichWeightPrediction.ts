import type {
  SmoothedWeightRow,
  WeightPrediction,
} from "../../../server/src/routers/body-analytics.ts";

const MIN_REPORTABLE_RATE_PER_WEEK_KG = 0.01;

function findLatestWeeklyChange(smoothedWeight: SmoothedWeightRow[]): number | null {
  for (let index = smoothedWeight.length - 1; index >= 0; index--) {
    const weeklyChange = smoothedWeight[index]?.weeklyChange;
    if (weeklyChange != null) return weeklyChange;
  }
  return null;
}

/**
 * When regression-based rate is unavailable, fall back to the latest weekly
 * change from smoothed weight — the same signal used by the trend chart bars.
 */
export function enrichWeightPrediction(
  prediction: WeightPrediction,
  smoothedWeight: SmoothedWeightRow[],
): WeightPrediction {
  if (prediction.ratePerWeek != null) return prediction;

  const latestWeeklyChange = findLatestWeeklyChange(smoothedWeight);
  if (latestWeeklyChange == null) return prediction;

  return {
    ...prediction,
    ratePerWeek: latestWeeklyChange,
    impliedDailyCalories:
      Math.abs(latestWeeklyChange) >= MIN_REPORTABLE_RATE_PER_WEEK_KG
        ? Math.round((latestWeeklyChange / 7) * 7700)
        : null,
  };
}
