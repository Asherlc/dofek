export type SleepTier = "Excellent" | "Good" | "Fair" | "Poor";

export interface SleepPerformanceResult {
  /** Performance score 0-100 */
  score: number;
  /** Tier label */
  tier: SleepTier;
  /** Component scores used to calculate performance */
  components?: SleepPerformanceComponents;
}

export interface SleepPerformanceComponents {
  hours: number;
  efficiency: number;
  consistency: number | null;
  lowStress: number | null;
}

export interface SleepPerformanceComponentInput {
  consistency?: number | null;
  lowStress?: number | null;
}

function clampPercent(value: number): number {
  return Math.min(Math.max(value, 0), 100);
}

function tierFromScore(score: number): SleepTier {
  if (score >= 90) return "Excellent";
  if (score >= 70) return "Good";
  if (score >= 50) return "Fair";
  return "Poor";
}

/**
 * Compute sleep performance from actual vs needed sleep and efficiency.
 * When consistency and stress components are supplied, score is the equal
 * average of all available provider-agnostic component scores.
 * Otherwise, preserves the original 70% sufficiency + 30% efficiency blend.
 * Tiers: Excellent (90+), Good (70-89), Fair (50-69), Poor (<50).
 */
export function computeSleepPerformance(
  actualMinutes: number,
  neededMinutes: number,
  efficiency: number,
  componentInput?: SleepPerformanceComponentInput,
): SleepPerformanceResult {
  const rawSufficiency = neededMinutes > 0 ? Math.min(actualMinutes / neededMinutes, 1) * 100 : 100;
  const hours = Math.round(rawSufficiency);
  const normalizedEfficiency = Math.round(clampPercent(efficiency));
  const consistency =
    componentInput?.consistency != null
      ? Math.round(clampPercent(componentInput.consistency))
      : null;
  const lowStress =
    componentInput?.lowStress != null ? Math.round(clampPercent(componentInput.lowStress)) : null;

  const components: SleepPerformanceComponents = {
    hours,
    efficiency: normalizedEfficiency,
    consistency,
    lowStress,
  };
  const componentScores = [hours, normalizedEfficiency, consistency, lowStress].filter(
    (value): value is number => value != null,
  );

  const hasExtraComponents = consistency != null || lowStress != null;
  const score = !hasExtraComponents
    ? Math.round(rawSufficiency * 0.7 + normalizedEfficiency * 0.3)
    : Math.round(componentScores.reduce((sum, value) => sum + value, 0) / componentScores.length);

  const clampedScore = Math.min(Math.max(score, 0), 100);

  return { score: clampedScore, tier: tierFromScore(clampedScore), components };
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
