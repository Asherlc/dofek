export type SleepTier = "Peak" | "Perform" | "Get By" | "Low";

export interface SleepPerformanceResult {
  /** Performance score 0-100 */
  score: number;
  /** Tier label */
  tier: SleepTier;
}

/**
 * Compute sleep performance from actual vs needed sleep and efficiency.
 * Score = 70% sufficiency (actual/needed, capped at 100%) + 30% efficiency.
 * Tiers: Peak (90+), Perform (70-89), Get By (50-69), Low (<50).
 */
export function computeSleepPerformance(
  actualMinutes: number,
  neededMinutes: number,
  efficiency: number,
): SleepPerformanceResult {
  const sufficiency = neededMinutes > 0 ? Math.min(actualMinutes / neededMinutes, 1) * 100 : 100;
  const normalizedEfficiency = Math.min(Math.max(efficiency, 0), 100);

  const score = Math.round(sufficiency * 0.7 + normalizedEfficiency * 0.3);
  const clampedScore = Math.min(Math.max(score, 0), 100);

  let tier: SleepTier;
  if (clampedScore >= 90) {
    tier = "Peak";
  } else if (clampedScore >= 70) {
    tier = "Perform";
  } else if (clampedScore >= 50) {
    tier = "Get By";
  } else {
    tier = "Low";
  }

  return { score: clampedScore, tier };
}

/**
 * Compute recommended bedtime given a wake time and sleep need.
 * @param wakeTime - Wake time in "HH:MM" format
 * @param sleepNeedMinutes - Total sleep need in minutes
 * @param fallAsleepMinutes - Estimated time to fall asleep (default 15)
 * @returns Recommended bedtime in "HH:MM" format
 */
export function computeRecommendedBedtime(
  wakeTime: string,
  sleepNeedMinutes: number,
  fallAsleepMinutes = 15,
): string {
  const [wakeHours, wakeMinutes] = wakeTime.split(":").map(Number);
  const wakeTotalMinutes = (wakeHours ?? 0) * 60 + (wakeMinutes ?? 0);
  const bedtimeTotalMinutes = wakeTotalMinutes - sleepNeedMinutes - fallAsleepMinutes;

  // Normalize to 0-1440 range (wrap around midnight)
  const normalized = ((bedtimeTotalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;

  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}
