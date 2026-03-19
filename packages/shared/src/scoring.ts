import { statusColors, textColors } from "./colors.ts";

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
  if (trend === "worsening") return statusColors.danger;
  return textColors.neutral;
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
