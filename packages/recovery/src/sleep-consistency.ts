/**
 * Sleep consistency scoring: how regular is the sleep schedule?
 *
 * Based on rolling 14-day standard deviation of bed/wake times.
 * Pure function with no database dependencies.
 */

/**
 * Compute a sleep consistency score (0-100) from bedtime and waketime standard deviations.
 *
 * Mapping: < 0.5 hr avg stddev → 100, > 1.5 hr → 0. Linear interpolation between.
 * Returns null if either stddev is null (insufficient data).
 */
export function computeSleepConsistencyScore(
  bedtimeStddevHours: number | null,
  waketimeStddevHours: number | null,
): number | null {
  if (bedtimeStddevHours == null || waketimeStddevHours == null) return null;

  const avgStddevHours = (bedtimeStddevHours + waketimeStddevHours) / 2;
  const score = Math.max(0, Math.min(100, (1 - (avgStddevHours - 0.5) / 1.0) * 100));
  return Math.round(score);
}
