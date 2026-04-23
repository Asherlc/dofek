/**
 * Heart rate and power zone models and utilities.
 *
 * Three models are supported:
 * 1. **Karvonen 5-zone** HR (%HRR) — standard 5-zone model for activity analysis
 * 2. **Treff 3-zone** HR (%HRmax) — simplified model for polarization index
 * 3. **Coggan 7-zone** cycling power (%FTP) — standard model for power analysis
 */

import { chartColors, statusColors } from "@dofek/scoring/colors";

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
  { zone: 1, label: "Recovery", minPctHrr: 0.5, maxPctHrr: 0.6, color: statusColors.info },
  { zone: 2, label: "Aerobic", minPctHrr: 0.6, maxPctHrr: 0.7, color: statusColors.positive },
  { zone: 3, label: "Tempo", minPctHrr: 0.7, maxPctHrr: 0.8, color: statusColors.warning },
  { zone: 4, label: "Threshold", minPctHrr: 0.8, maxPctHrr: 0.9, color: statusColors.elevated },
  { zone: 5, label: "VO2max", minPctHrr: 0.9, maxPctHrr: 1.0, color: statusColors.danger },
];

/** Ordered array of zone colors for chart series (indexed 0-4 for zones 1-5). */
export const HEART_RATE_ZONE_COLORS: string[] = HEART_RATE_ZONES.map((z) => z.color);

/**
 * Zone boundary fractions for SQL interpolation.
 * These are the upper bounds of each zone (as %HRR fractions):
 * [0.6, 0.7, 0.8, 0.9] — the boundary between zone N and zone N+1.
 *
 * Use these instead of hardcoding 0.6, 0.7, 0.8, 0.9 in SQL queries
 * so zone definitions stay in sync across the codebase.
 */
export const ZONE_BOUNDARIES_HRR = HEART_RATE_ZONES.slice(0, -1).map((z) => z.maxPctHrr);

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

// ── Coggan 7-Zone Cycling Power Model ───────────────────────────────

export interface PowerZoneDefinition {
  zone: number;
  label: string;
  /** Lower bound as fraction of FTP (e.g. 0.55 = 55% FTP). 0 for zone 1. */
  minPctFtp: number;
  /** Upper bound as fraction of FTP. Infinity for the open-ended top zone. */
  maxPctFtp: number;
  color: string;
}

export interface PowerZoneBoundary {
  zone: number;
  label: string;
  minWatts: number;
  /** null when the zone is open-ended (Z7 has no upper bound). */
  maxWatts: number | null;
  color: string;
}

export interface ActivityPowerZone {
  zone: number;
  label: string;
  /** Lower bound as integer percentage of FTP (e.g. 55). */
  minPct: number;
  /** Upper bound as integer percentage of FTP. null for Z7 (open-ended). */
  maxPct: number | null;
  seconds: number;
}

/**
 * Standard Coggan 7-zone model using % Functional Threshold Power.
 *
 * Zone boundary = ftp × fraction.
 */
export const POWER_ZONES: PowerZoneDefinition[] = [
  { zone: 1, label: "Active Recovery", minPctFtp: 0, maxPctFtp: 0.55, color: chartColors.teal },
  { zone: 2, label: "Endurance", minPctFtp: 0.55, maxPctFtp: 0.75, color: statusColors.info },
  { zone: 3, label: "Tempo", minPctFtp: 0.75, maxPctFtp: 0.9, color: statusColors.positive },
  { zone: 4, label: "Threshold", minPctFtp: 0.9, maxPctFtp: 1.05, color: statusColors.warning },
  { zone: 5, label: "VO2max", minPctFtp: 1.05, maxPctFtp: 1.2, color: statusColors.elevated },
  { zone: 6, label: "Anaerobic", minPctFtp: 1.2, maxPctFtp: 1.5, color: statusColors.danger },
  {
    zone: 7,
    label: "Neuromuscular",
    minPctFtp: 1.5,
    maxPctFtp: Number.POSITIVE_INFINITY,
    color: chartColors.purple,
  },
];

/** Ordered array of zone colors for chart series (indexed 0-6 for zones 1-7). */
export const POWER_ZONE_COLORS: string[] = POWER_ZONES.map((z) => z.color);

/**
 * Zone boundary fractions for SQL interpolation.
 * Upper bounds of each zone except the last (as %FTP fractions):
 * [0.55, 0.75, 0.9, 1.05, 1.2, 1.5].
 */
export const ZONE_BOUNDARIES_FTP = POWER_ZONES.slice(0, -1).map((z) => z.maxPctFtp);

/**
 * Compute absolute wattage boundaries for each zone given an FTP value.
 */
export function powerZoneBoundaries(ftp: number): PowerZoneBoundary[] {
  return POWER_ZONES.map((z) => ({
    zone: z.zone,
    label: z.label,
    minWatts: Math.round(ftp * z.minPctFtp),
    maxWatts: Number.isFinite(z.maxPctFtp) ? Math.round(ftp * z.maxPctFtp) : null,
    color: z.color,
  }));
}

/**
 * Classify a power reading into zone 1-7.
 */
export function classifyPowerZone(power: number, ftp: number): number {
  for (let i = POWER_ZONES.length - 1; i >= 0; i--) {
    const zone = POWER_ZONES[i];
    if (!zone) continue;
    if (power >= ftp * zone.minPctFtp) return zone.zone;
  }
  return 1;
}

/**
 * Map raw DB zone rows to the full 7-zone structure.
 * Missing zones get 0 seconds.
 */
export function mapPowerZones(rows: { zone: number; seconds: number }[]): ActivityPowerZone[] {
  return POWER_ZONES.map((z) => {
    const row = rows.find((r) => Number(r.zone) === z.zone);
    return {
      zone: z.zone,
      label: z.label,
      minPct: Math.round(z.minPctFtp * 100),
      maxPct: Number.isFinite(z.maxPctFtp) ? Math.round(z.maxPctFtp * 100) : null,
      seconds: row ? Number(row.seconds) : 0,
    };
  });
}
