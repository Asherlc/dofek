/**
 * Heart rate zone definitions and computation.
 *
 * Two models:
 * 1. **Karvonen 5-zone model** — uses Heart Rate Reserve (HRR = maxHr - restingHr)
 *    to compute zone boundaries as percentages of HRR added to resting HR.
 * 2. **%HRmax 3-zone model** — uses simple percentages of max HR (Treff model
 *    for polarization analysis).
 */

/** A heart rate zone with its boundaries expressed as both percentages and absolute HR values. */
export interface HeartRateZone {
  zone: number;
  label: string;
  /** Lower bound as a fraction (e.g. 0.5 = 50%) */
  minPct: number;
  /** Upper bound as a fraction (e.g. 0.6 = 60%) */
  maxPct: number;
  /** Lower bound absolute HR (inclusive) */
  minHr: number;
  /** Upper bound absolute HR (exclusive, except for the highest zone) */
  maxHr: number;
}

/**
 * Karvonen 5-zone definitions: percentage boundaries of Heart Rate Reserve.
 * Z1 starts at 50% HRR to exclude sub-threshold heart rates.
 */
export const KARVONEN_ZONE_DEFINITIONS = [
  { zone: 1, label: "Recovery", minPct: 0.5, maxPct: 0.6 },
  { zone: 2, label: "Aerobic", minPct: 0.6, maxPct: 0.7 },
  { zone: 3, label: "Tempo", minPct: 0.7, maxPct: 0.8 },
  { zone: 4, label: "Threshold", minPct: 0.8, maxPct: 0.9 },
  { zone: 5, label: "Anaerobic", minPct: 0.9, maxPct: 1.0 },
] as const;

/**
 * %HRmax 3-zone definitions for polarization analysis (Treff model).
 * Z1 starts at 0% to capture all sub-threshold heart rates.
 */
export const MAX_HR_ZONE_DEFINITIONS = [
  { zone: 1, label: "Easy", minPct: 0, maxPct: 0.8 },
  { zone: 2, label: "Threshold", minPct: 0.8, maxPct: 0.9 },
  { zone: 3, label: "High Intensity", minPct: 0.9, maxPct: 1.0 },
] as const;

/** Human-readable labels for the 5 Karvonen zones (indexed 0-4 for zones 1-5). */
export const HR_ZONE_LABELS: readonly string[] = KARVONEN_ZONE_DEFINITIONS.map((d) => d.label);

/**
 * Colors for the 5 Karvonen HR zones (indexed 0-4 for zones 1-5).
 * Green-to-red gradient matching the per-activity zone chart colors used on
 * both web and iOS.
 */
export const HR_ZONE_COLORS: readonly string[] = [
  "#22c55e", // Z1 Recovery  (green)
  "#84cc16", // Z2 Aerobic   (lime)
  "#eab308", // Z3 Tempo     (yellow)
  "#f97316", // Z4 Threshold (orange)
  "#ef4444", // Z5 Anaerobic (red)
];

/**
 * Compute Karvonen (Heart Rate Reserve) 5-zone boundaries.
 *
 * Each zone boundary is: restingHr + HRR * pct, where HRR = maxHr - restingHr.
 * This matches the SQL used in activity.hrZones and training.hrZones routers.
 */
export function computeKarvonenZones(maxHr: number, restingHr: number): HeartRateZone[] {
  const heartRateReserve = maxHr - restingHr;
  return KARVONEN_ZONE_DEFINITIONS.map((def) => ({
    zone: def.zone,
    label: def.label,
    minPct: def.minPct,
    maxPct: def.maxPct,
    minHr: restingHr + heartRateReserve * def.minPct,
    maxHr: restingHr + heartRateReserve * def.maxPct,
  }));
}

/**
 * Compute %HRmax 3-zone boundaries (Treff model for polarization).
 *
 * Each zone boundary is a simple percentage of maxHr.
 * This matches the SQL used in efficiency.polarizationTrend router.
 */
export function computeMaxHrZones(maxHr: number): HeartRateZone[] {
  return MAX_HR_ZONE_DEFINITIONS.map((def) => ({
    zone: def.zone,
    label: def.label,
    minPct: def.minPct,
    maxPct: def.maxPct,
    minHr: maxHr * def.minPct,
    maxHr: maxHr * def.maxPct,
  }));
}

/**
 * Determine which zone a given heart rate falls into.
 *
 * Returns the zone number (1-based) or 0 if the HR is below all zone boundaries.
 * HR on a zone boundary goes to the higher zone (lower bound inclusive, upper
 * bound exclusive), except for the highest zone which includes its upper bound.
 */
export function getZoneForHeartRate(hr: number, zones: HeartRateZone[]): number {
  // Walk zones from highest to lowest so we find the first where hr >= minHr.
  for (let i = zones.length - 1; i >= 0; i--) {
    const zone = zones[i];
    if (zone && hr >= zone.minHr) {
      return zone.zone;
    }
  }
  return 0;
}
