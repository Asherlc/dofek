import { statusColors, textColors } from "./colors.ts";

/**
 * Scaling constant for converting raw training load to Whoop-like 0-21 strain.
 * Calibrated so a moderate 60-min workout (~45 raw) maps to ~13 strain,
 * a hard 90-min workout (~76 raw) maps to ~15, and extreme multi-hour efforts
 * approach but don't exceed 21.
 */
const STRAIN_SCALE_FACTOR = 3.5;
const STRAIN_MAX = 21;

/**
 * Convert raw daily training load (duration_min × avg_hr/max_hr) to a
 * Whoop-like 0–21 strain score using logarithmic scaling.
 *
 * The logarithmic transformation produces diminishing returns at higher loads,
 * matching Whoop's bounded scale where going from 15→16 requires more effort
 * than going from 5→6.
 */
export function rawLoadToStrain(rawLoad: number): number {
  if (rawLoad <= 0) return 0;
  const strain = STRAIN_SCALE_FACTOR * Math.log(1 + rawLoad);
  return Math.round(Math.min(strain, STRAIN_MAX) * 10) / 10;
}

/** Get the color for a strain score (0-21 Whoop-like scale) */
export function strainColor(strain: number): string {
  if (strain > 17) return statusColors.danger;
  if (strain >= 14) return statusColors.warning;
  if (strain >= 10) return statusColors.positive;
  return textColors.secondary;
}

/** Get a human-readable label for a strain score (0-21 Whoop-like scale) */
export function strainLabel(strain: number): string {
  if (strain > 17) return "All Out";
  if (strain >= 14) return "High";
  if (strain >= 10) return "Moderate";
  return "Light";
}

/** Get the color for a recovery/readiness score (0-100) */
export function scoreColor(score: number): string {
  if (score > 70) return statusColors.positive;
  if (score >= 50) return statusColors.warning;
  return statusColors.danger;
}

/** Get a human-readable label for a recovery score (0-100) */
export function scoreLabel(score: number): string {
  if (score > 70) return "Recovered";
  if (score >= 50) return "Moderate";
  return "Poor";
}

/** Get the color for a strain zone ("restoring" | "optimal" | "overreaching") */
export function strainZoneColor(zone: string): string {
  if (zone === "optimal") return statusColors.positive;
  if (zone === "overreaching") return statusColors.danger;
  if (zone === "restoring") return statusColors.info;
  return textColors.secondary;
}

/** Get a human-readable label for a strain zone */
export function strainZoneLabel(zone: string): string {
  if (zone === "optimal") return "Optimal";
  if (zone === "overreaching") return "Overreaching";
  if (zone === "restoring") return "Restoring";
  return zone;
}

/** Get the color for a workload ratio value */
export function workloadRatioColor(ratio: number | null): string {
  if (ratio == null) return textColors.secondary;
  if (ratio >= 0.8 && ratio <= 1.3) return statusColors.positive;
  if (ratio >= 0.5 && ratio <= 1.5) return statusColors.warning;
  return statusColors.danger;
}

/** Get a human-readable hint for a workload ratio value */
export function workloadRatioHint(ratio: number): string {
  if (ratio >= 0.8 && ratio <= 1.3) return "Optimal training zone";
  if (ratio < 0.8) return "Detraining risk - increase load gradually";
  if (ratio <= 1.5) return "High load - monitor recovery closely";
  return "Injury risk zone - consider rest";
}

export interface WeekSummary {
  week: string;
  hours: number;
  fraction: number;
}

/** Aggregate weekly volume rows into a summary with relative fractions */
export function aggregateWeeklyVolume(rows: Array<{ week: string; hours: number }>): WeekSummary[] {
  const weekMap = new Map<string, number>();
  for (const row of rows) {
    weekMap.set(row.week, (weekMap.get(row.week) ?? 0) + row.hours);
  }
  const entries = Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-4);
  const maxHours = Math.max(...entries.map(([, h]) => h), 1);
  return entries.map(([week, hours]) => ({
    week,
    hours,
    fraction: hours / maxHours,
  }));
}

/** Determine trend direction from two values */
export function trendDirection(current: number, previous: number): "up" | "down" | "stable" {
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "stable";
}

/** Get the color for a stress score (0-3 scale) */
export function stressColor(score: number): string {
  if (score <= 0.5) return statusColors.positive;
  if (score <= 1.5) return statusColors.warning;
  if (score <= 2.5) return statusColors.elevated;
  return statusColors.danger;
}

/** Get a human-readable label for a stress score (0-3 scale) */
export function stressLabel(score: number): string {
  if (score <= 0.5) return "Low";
  if (score <= 1.5) return "Moderate";
  if (score <= 2.5) return "High";
  return "Very High";
}

/** Get the color for a trend direction */
export function trendColor(trend: "improving" | "worsening" | "stable" | "declining"): string {
  if (trend === "improving") return statusColors.positive;
  if (trend === "worsening" || trend === "declining") return statusColors.danger;
  return textColors.neutral;
}

/** Get the color for a categorical readiness level (high/moderate/low) */
export function readinessLevelColor(level: "high" | "moderate" | "low" | "unknown"): string {
  if (level === "high") return statusColors.positive;
  if (level === "moderate") return statusColors.warning;
  if (level === "low") return statusColors.danger;
  return textColors.neutral;
}

/** Get the color for a health metric status (excellent/good/fair/poor) */
export function healthStatusColor(status: "excellent" | "good" | "fair" | "poor"): string {
  if (status === "excellent") return statusColors.positive;
  if (status === "good") return statusColors.info;
  if (status === "fair") return statusColors.warning;
  return statusColors.danger;
}

/** Get the color for a ramp rate value (always uses absolute value) */
export function rampRateColor(rate: number): string {
  const absRate = Math.abs(rate);
  if (absRate < 5) return statusColors.positive;
  if (absRate <= 7) return statusColors.warning;
  return statusColors.danger;
}

/** Get the color for sleep debt in minutes */
export function sleepDebtColor(minutes: number): string {
  if (minutes <= 0) return statusColors.positive;
  if (minutes < 120) return statusColors.warning;
  return statusColors.danger;
}

/** Form zone boundaries (intervals.icu defaults) */
export const FORM_ZONE_TRANSITION = 25;
export const FORM_ZONE_FRESH = 5;
export const FORM_ZONE_GREY = -10;
export const FORM_ZONE_OPTIMAL = -30;

/** Colors for form (training stress balance) zones */
export const FORM_ZONE_COLORS = {
  transition: "#60a5fa",
  fresh: "#22c55e",
  grey: "#a1a1aa",
  optimal: "#22c55e",
  highRisk: "#ef4444",
} as const;

/** Get the color for a form score (training stress balance) value */
export function formZoneColor(formScore: number): string {
  if (formScore > FORM_ZONE_TRANSITION) return FORM_ZONE_COLORS.transition;
  if (formScore > FORM_ZONE_FRESH) return FORM_ZONE_COLORS.fresh;
  if (formScore > FORM_ZONE_GREY) return FORM_ZONE_COLORS.grey;
  if (formScore > FORM_ZONE_OPTIMAL) return FORM_ZONE_COLORS.optimal;
  return FORM_ZONE_COLORS.highRisk;
}

/** Get a human-readable zone label for a form score value */
export function formZoneLabel(formScore: number): string {
  if (formScore > FORM_ZONE_TRANSITION) return "Transition";
  if (formScore > FORM_ZONE_FRESH) return "Fresh";
  if (formScore > FORM_ZONE_GREY) return "Grey Zone";
  if (formScore > FORM_ZONE_OPTIMAL) return "Optimal";
  return "High Risk";
}
