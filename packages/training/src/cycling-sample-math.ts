/**
 * Private numeric helpers shared by the cycling workout modules. Both operate on
 * gap-aware 1 Hz sample streams; the caller owns the coverage policy.
 */

/** Gap-aware mean: missing seconds are skipped and measured zeros are kept. */
export function average(values: ReadonlyArray<number | null>): number | null {
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (value == null) continue;
    total += value;
    count++;
  }
  return count === 0 ? null : total / count;
}

export function round(value: number, decimals = 1): number {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}
