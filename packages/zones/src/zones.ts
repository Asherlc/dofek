/**
 * Heart rate and power zone models and utilities.
 *
 * Three models are supported:
 * 1. **Karvonen HR zones** (%HRR) — zone 0 plus the standard 5 training zones
 * 2. **Treff 3-zone** HR (%HRmax) — simplified model for polarization index
 * 3. **7-zone** cycling power (%FTP) — standard model for power analysis
 */

import { chartColors, statusColors, textColors } from "@dofek/scoring/colors";

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
  /** Percentage of activity zone time spent in this zone. */
  percent: number;
}

export interface ZoneDistributionDatum {
  zone: number;
  label: string;
  seconds: number;
  percent: number;
}

export interface ZoneDistributionRow<ZoneItem extends ZoneDistributionDatum> {
  key: string;
  primaryLabel: string;
  subordinateLabel: string | null;
  axisLabel: string;
  percentLabel: string;
  color: string;
  zone: ZoneItem;
}

export interface PolarizationZoneDefinition {
  zone: number;
  label: string;
  /** Lower bound as fraction of HRmax (0 for zone 1) */
  minPctHrmax: number;
  /** Upper bound as fraction of HRmax (1 for zone 3) */
  maxPctHrmax: number;
}

// ── Karvonen Heart Rate Zones ────────────────────────────────────────

/**
 * Karvonen model using % Heart Rate Reserve.
 *
 * HRR = maxHr - restingHr
 * Zone boundary = restingHr + HRR * fraction
 */
export const HEART_RATE_ZONES: HeartRateZoneDefinition[] = [
  { zone: 0, label: "Below Zone 1", minPctHrr: 0, maxPctHrr: 0.5, color: textColors.neutral },
  { zone: 1, label: "Recovery", minPctHrr: 0.5, maxPctHrr: 0.6, color: statusColors.info },
  { zone: 2, label: "Aerobic", minPctHrr: 0.6, maxPctHrr: 0.7, color: statusColors.positive },
  { zone: 3, label: "Tempo", minPctHrr: 0.7, maxPctHrr: 0.8, color: statusColors.warning },
  { zone: 4, label: "Threshold", minPctHrr: 0.8, maxPctHrr: 0.9, color: statusColors.elevated },
  { zone: 5, label: "VO2max", minPctHrr: 0.9, maxPctHrr: 1.0, color: statusColors.danger },
];

/** Ordered array of zone colors for chart series (indexed 0-5 for zones 0-5). */
export const HEART_RATE_ZONE_COLORS: string[] = HEART_RATE_ZONES.map((z) => z.color);

/**
 * Zone boundary fractions for SQL interpolation.
 * These are the upper bounds of each zone (as %HRR fractions):
 * [0.5, 0.6, 0.7, 0.8, 0.9] — the boundary between zone N and zone N+1.
 *
 * Use these instead of hardcoding HRR thresholds in SQL queries
 * so zone definitions stay in sync across the codebase.
 */
export const ZONE_BOUNDARIES_HRR = HEART_RATE_ZONES.slice(0, -1).map((z) => z.maxPctHrr);

export function formatZoneDistributionAxisLabel(zoneItem: ZoneDistributionDatum): string {
  const primaryLabel = formatZoneDistributionPrimaryLabel(zoneItem);
  const subordinateLabel = formatZoneDistributionSubordinateLabel(zoneItem);
  return subordinateLabel == null ? primaryLabel : `${primaryLabel}\n${subordinateLabel}`;
}

export function formatZoneDistributionPrimaryLabel(zoneItem: ZoneDistributionDatum): string {
  if (zoneItem.zone === 0) return zoneItem.label;
  return `Zone ${zoneItem.zone}`;
}

export function formatZoneDistributionSubordinateLabel(
  zoneItem: ZoneDistributionDatum,
): string | null {
  if (zoneItem.zone === 0) return null;
  return zoneItem.label;
}

export function formatZoneDistributionPercentLabel(zoneItem: ZoneDistributionDatum): string {
  return `${Math.round(zoneItem.percent)}%`;
}

export function hasZoneDistributionData(zones: ZoneDistributionDatum[]): boolean {
  return zones.some((zoneItem) => zoneItem.percent > 0);
}

export function createZoneDistributionRows<ZoneItem extends ZoneDistributionDatum>(
  zones: ZoneItem[],
  zoneColors: string[],
  fallbackColor: string = textColors.neutral,
): ZoneDistributionRow<ZoneItem>[] {
  return zones.map((zoneItem, zoneIndex) => ({
    key: String(zoneItem.zone),
    primaryLabel: formatZoneDistributionPrimaryLabel(zoneItem),
    subordinateLabel: formatZoneDistributionSubordinateLabel(zoneItem),
    axisLabel: formatZoneDistributionAxisLabel(zoneItem),
    percentLabel: formatZoneDistributionPercentLabel(zoneItem),
    color: zoneColors[zoneIndex] ?? fallbackColor,
    zone: zoneItem,
  }));
}

export function formatHeartRateZoneRangeLabel(zoneItem: ActivityHrZone): string {
  return `${zoneItem.minPct}-${zoneItem.maxPct}% Heart Rate Reserve`;
}

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
 * Classify a heart rate reading into zone 0-5.
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
 * Compute the absolute BPM range for a specific zone number (0-5).
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
 * Map raw DB zone rows to the full heart-rate zone structure.
 * Missing zones get 0 seconds. Used by activity and training routers.
 */
export function mapHrZones(rows: { zone: number; seconds: number }[]): ActivityHrZone[] {
  const totalSeconds = rows.reduce((sum, row) => sum + Number(row.seconds), 0);
  return HEART_RATE_ZONES.map((zoneDefinition) => {
    const row = rows.find((candidateRow) => Number(candidateRow.zone) === zoneDefinition.zone);
    const seconds = row ? Number(row.seconds) : 0;
    return {
      zone: zoneDefinition.zone,
      label: zoneDefinition.label,
      minPct: Math.round(zoneDefinition.minPctHrr * 100),
      maxPct: Math.round(zoneDefinition.maxPctHrr * 100),
      seconds,
      percent: totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 1000) / 10 : 0,
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
 * PI = log10((f1 / f2) * f3 * 100)
 * where f = fraction of total training time in each zone.
 *
 * PI > 2.0 matches Treff's descriptive polarized-distribution heuristic.
 * Returns null if any zone has zero time or Zone 3 exceeds Zone 1.
 */
export function computePolarizationIndex(
  z1Seconds: number,
  z2Seconds: number,
  z3Seconds: number,
): number | null {
  if (z2Seconds <= 0 || z3Seconds <= 0 || z3Seconds > z1Seconds) return null;
  const total = z1Seconds + z2Seconds + z3Seconds;

  const f1 = z1Seconds / total;
  const f2 = z2Seconds / total;
  const f3 = z3Seconds / total;
  const ratio = (f1 / f2) * f3 * 100;
  return Math.round(Math.log10(ratio) * 1000) / 1000;
}

// ── 7-Zone Cycling Power Model ──────────────────────────────────────

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
  /** Percentage of activity zone time spent in this zone. */
  percent: number;
}

/**
 * Standard 7-zone model using % Functional Threshold Power.
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

export function formatPowerZoneRangeLabel(zoneItem: ActivityPowerZone, ftp: number): string {
  const minWatts = Math.round((zoneItem.minPct / 100) * ftp);
  const maxWatts = zoneItem.maxPct != null ? Math.round((zoneItem.maxPct / 100) * ftp) : null;
  const percentLabel =
    zoneItem.maxPct != null
      ? `${zoneItem.minPct}-${zoneItem.maxPct}% Threshold Power`
      : `>${zoneItem.minPct}% Threshold Power`;
  const wattLabel = maxWatts != null ? `${minWatts}-${maxWatts} W` : `>${minWatts} W`;
  return `${percentLabel} (${wattLabel})`;
}

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
  const totalSeconds = rows.reduce((sum, row) => sum + Number(row.seconds), 0);
  return POWER_ZONES.map((zoneDefinition) => {
    const row = rows.find((candidateRow) => Number(candidateRow.zone) === zoneDefinition.zone);
    const seconds = row ? Number(row.seconds) : 0;
    return {
      zone: zoneDefinition.zone,
      label: zoneDefinition.label,
      minPct: Math.round(zoneDefinition.minPctFtp * 100),
      maxPct: Number.isFinite(zoneDefinition.maxPctFtp)
        ? Math.round(zoneDefinition.maxPctFtp * 100)
        : null,
      seconds,
      percent: totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 1000) / 10 : 0,
    };
  });
}
