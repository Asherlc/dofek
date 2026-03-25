/**
 * Healthspan Years — maps a healthspan score (0-100) to a biological age delta.
 *
 * Score 0 → +3 years (aging faster than chronological age)
 * Score 50 → 0 years (aging at expected rate)
 * Score 100 → -2 years (aging slower than chronological age)
 *
 * The scale is intentionally asymmetric: poor health has a bigger penalty
 * than good health has a benefit, reflecting longevity research showing
 * inactivity/poor sleep shortens life more than peak fitness extends it.
 */

/**
 * Convert a healthspan score (0-100) to a years-of-life delta.
 * Positive = aging faster (losing years). Negative = aging slower (gaining years).
 */
export function scoreToYearsDelta(score: number): number {
  const clamped = Math.max(0, Math.min(100, score));

  if (clamped <= 50) {
    // 0→+3, 50→0 (linear interpolation)
    return Math.round((3 - (clamped / 50) * 3) * 10) / 10;
  }
  // 50→0, 100→-2 (linear interpolation)
  return Math.round((-(clamped - 50) / 50) * 2 * 10) / 10;
}

/**
 * Format a years delta for display.
 * Examples: "+1.5 yr", "-2.0 yr", "+0.0 yr"
 */
export function formatYearsDelta(years: number): string {
  const sign = years >= 0 ? "+" : "";
  return `${sign}${years.toFixed(1)} yr`;
}
