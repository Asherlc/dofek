export function computeBoundsFromIsoTimestamps(
  timestamps: string[],
): { startAt: string; endAt: string } | null {
  if (timestamps.length === 0) return null;

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const ts of timestamps) {
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) continue;
    if (ms < minTs) minTs = ms;
    if (ms > maxTs) maxTs = ms;
  }

  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return null;
  return {
    startAt: new Date(minTs).toISOString(),
    endAt: new Date(maxTs).toISOString(),
  };
}
