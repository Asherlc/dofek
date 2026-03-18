export interface SleepTargetInput {
  durationMinutes: number;
  /** Whether next-day HRV was above the user's rolling median */
  nextDayHrvAboveMedian: boolean;
}

export interface SleepTargetFitResult {
  /** Optimal sleep target in minutes */
  minutes: number;
  /** Number of qualifying (good recovery) nights used */
  sampleCount: number;
}

const MIN_QUALIFYING_NIGHTS = 14;

/**
 * Derive a personalized sleep target from the user's data.
 *
 * Computes the average sleep duration on nights that preceded
 * above-median HRV (i.e., good recovery). This represents the
 * amount of sleep the user typically needs for good recovery.
 *
 * Returns null if fewer than 14 qualifying nights exist.
 */
export function fitSleepTarget(data: SleepTargetInput[]): SleepTargetFitResult | null {
  const goodNights = data.filter((d) => d.nextDayHrvAboveMedian);

  if (goodNights.length < MIN_QUALIFYING_NIGHTS) return null;

  const totalDuration = goodNights.reduce((sum, night) => sum + night.durationMinutes, 0);
  const avgDuration = totalDuration / goodNights.length;

  return {
    minutes: Math.round(avgDuration),
    sampleCount: goodNights.length,
  };
}
