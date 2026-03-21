/**
 * Heart rate zone models and utilities.
 *
 * Two models are supported:
 * 1. **Karvonen 5-zone** (%HRR) — standard 5-zone model for activity analysis
 * 2. **Treff 3-zone** (%HRmax) — simplified model for polarization index
 */

// ── Types ────────────────────────────────────────────────────────────

export interface HeartRateZoneDefinition {
  zone: number;
  label: string;
  /** Lower bound as fraction of Heart Rate Reserve (e.g. 0.5 = 50% HRR) */
  minPctHrr: number;
  /** Upper bound as fraction of Heart Rate Reserve */
  maxPctHrr: number;
  color: string;
}

export interface HeartRateZoneBoundary {
  zone: number;
  label: string;
  minBpm: number;
  maxBpm: number;
  color: string;
}

export interface ActivityHrZone {
  zone: number;
  label: string;
  /** Lower bound as integer percentage of HRR (e.g. 50) */
  minPct: number;
  /** Upper bound as integer percentage of HRR (e.g. 60) */
  maxPct: number;
  seconds: number;
}

export interface PolarizationZoneDefinition {
  zone: number;
  label: string;
  /** Lower bound as fraction of HRmax (0 for zone 1) */
  minPctHrmax: number;
  /** Upper bound as fraction of HRmax (1 for zone 3) */
  maxPctHrmax: number;
}

// ── Karvonen 5-Zone Model ────────────────────────────────────────────

/**
 * Standard 5-zone Karvonen model using % Heart Rate Reserve.
 *
 * HRR = maxHr - restingHr
 * Zone boundary = restingHr + HRR * fraction
 */
export const HEART_RATE_ZONES: HeartRateZoneDefinition[] = [
  { zone: 1, label: "Recovery", minPctHrr: 0.5, maxPctHrr: 0.6, color: "#3b82f6" },
  { zone: 2, label: "Aerobic", minPctHrr: 0.6, maxPctHrr: 0.7, color: "#22c55e" },
  { zone: 3, label: "Tempo", minPctHrr: 0.7, maxPctHrr: 0.8, color: "#eab308" },
  { zone: 4, label: "Threshold", minPctHrr: 0.8, maxPctHrr: 0.9, color: "#f97316" },
  { zone: 5, label: "VO2max", minPctHrr: 0.9, maxPctHrr: 1.0, color: "#ef4444" },
];

/** Ordered array of zone colors for chart series (indexed 0-4 for zones 1-5). */
export const HEART_RATE_ZONE_COLORS: string[] = HEART_RATE_ZONES.map((z) => z.color);

/**
 * Compute absolute BPM boundaries for each zone given a user's max HR and resting HR.
 */
export function heartRateZoneBoundaries(maxHr: number, restingHr: number): HeartRateZoneBoundary[] {
  const reserve = maxHr - restingHr;
  return HEART_RATE_ZONES.map((z) => ({
    zone: z.zone,
    label: z.label,
    minBpm: Math.round(restingHr + reserve * z.minPctHrr),
    maxBpm: Math.round(restingHr + reserve * z.maxPctHrr),
    color: z.color,
  }));
}

/**
 * Classify a heart rate reading into zone 1-5.
 * Returns 0 if the heart rate is below zone 1 (< 50% HRR).
 */
export function classifyHeartRateZone(heartRate: number, maxHr: number, restingHr: number): number {
  const reserve = maxHr - restingHr;
  // Walk zones in reverse to find the highest matching zone
  for (let i = HEART_RATE_ZONES.length - 1; i >= 0; i--) {
    const zone = HEART_RATE_ZONES[i];
    if (!zone) continue;
    const threshold = restingHr + reserve * zone.minPctHrr;
    if (heartRate >= threshold) return zone.zone;
  }
  return 0;
}

/**
 * Compute the absolute BPM range for a specific zone number (1-5).
 * Returns null if maxHr or restingHr is null.
 */
export function computeHrRange(
  maxHr: number | null,
  restingHr: number | null,
  zone: number,
): { min: number; max: number } | null {
  if (maxHr == null || restingHr == null) return null;
  const zoneDef = HEART_RATE_ZONES.find((z) => z.zone === zone);
  if (!zoneDef) return null;
  const reserve = maxHr - restingHr;
  return {
    min: Math.round(restingHr + reserve * zoneDef.minPctHrr),
    max: Math.round(restingHr + reserve * zoneDef.maxPctHrr),
  };
}

/**
 * Map raw DB zone rows to the full 5-zone structure.
 * Missing zones get 0 seconds. Used by activity and training routers.
 */
export function mapHrZones(rows: { zone: number; seconds: number }[]): ActivityHrZone[] {
  return HEART_RATE_ZONES.map((z) => {
    const row = rows.find((r) => Number(r.zone) === z.zone);
    return {
      zone: z.zone,
      label: z.label,
      minPct: Math.round(z.minPctHrr * 100),
      maxPct: Math.round(z.maxPctHrr * 100),
      seconds: row ? Number(row.seconds) : 0,
    };
  });
}

// ── Treff 3-Zone Polarization Model ─────────────────────────────────

/**
 * Treff 3-zone model for polarization analysis.
 * Uses %HRmax (simpler and more stable than Karvonen %HRR).
 */
export const POLARIZATION_ZONES: PolarizationZoneDefinition[] = [
  { zone: 1, label: "Easy", minPctHrmax: 0, maxPctHrmax: 0.8 },
  { zone: 2, label: "Threshold", minPctHrmax: 0.8, maxPctHrmax: 0.9 },
  { zone: 3, label: "High Intensity", minPctHrmax: 0.9, maxPctHrmax: 1.0 },
];

/**
 * Compute the Treff Polarization Index from zone time distribution.
 *
 * PI = log10((f1 / (f2 * f3)) * 100)
 * where f = fraction of total training time in each zone.
 *
 * PI > 2.0 indicates a well-polarized training distribution.
 * Returns null if any zone has zero time.
 */
export function computePolarizationIndex(
  z1Seconds: number,
  z2Seconds: number,
  z3Seconds: number,
): number | null {
  if (z1Seconds <= 0 || z2Seconds <= 0 || z3Seconds <= 0) return null;
  const total = z1Seconds + z2Seconds + z3Seconds;
  if (total <= 0) return null;

  const f1 = z1Seconds / total;
  const f2 = z2Seconds / total;
  const f3 = z3Seconds / total;
  const ratio = (f1 / (f2 * f3)) * 100;
  return Math.round(Math.log10(ratio) * 1000) / 1000;
}
