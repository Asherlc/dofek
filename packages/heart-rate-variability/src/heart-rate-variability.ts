/**
 * Select the overnight HRV reading from a set of same-day samples.
 *
 * Apple Watch records SDNN during both sleep and Breathe/Mindfulness sessions.
 * Breathe session values are typically ~2x the overnight baseline because the
 * deliberate slow breathing maximises parasympathetic tone. Using the earliest
 * reading of the day avoids this inflation — overnight/early-morning readings
 * come first chronologically and reflect resting autonomic status.
 */
export function selectDailyHeartRateVariability(
  samples: ReadonlyArray<{ value: number; startDate: Date | string }>,
): number | null {
  if (samples.length === 0) return null;

  let earliest: { value: number; time: number } | null = null;

  for (const sample of samples) {
    const time =
      sample.startDate instanceof Date ? sample.startDate.getTime() : Date.parse(sample.startDate);

    if (earliest === null || time < earliest.time) {
      earliest = { value: sample.value, time };
    }
  }

  return earliest?.value ?? null;
}
