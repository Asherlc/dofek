/**
 * Select the daily HRV reading from a set of same-day samples.
 *
 * Apple Watch records SDNN during both sleep and background spot checks.
 * Using the average of all readings provides a more representative daily baseline
 * than picking a single (potentially noisy) sample.
 */
export function selectDailyHeartRateVariability(
  samples: ReadonlyArray<{ value: number; startDate: Date | string }>,
): number | null {
  if (samples.length === 0) return null;

  let sum = 0;
  for (const sample of samples) {
    sum += sample.value;
  }

  return Math.round(sum / samples.length);
}
