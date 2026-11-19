/** Whole seconds per kilometre derived from a positive average speed (m/s). */
export function averageRunPaceSecondsPerKm(avgSpeed: number | null): number | null {
  return avgSpeed != null && avgSpeed > 0 ? Math.round(1000 / avgSpeed) : null;
}
