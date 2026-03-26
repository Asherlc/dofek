import { statusColors, textColors } from "./colors.ts";

/**
 * Whoop-like 0–21 strain score with display classification.
 *
 * Construct directly with a strain value or use `fromRawLoad()` to convert
 * raw daily training load (duration_min × avg_hr/max_hr) using logarithmic
 * scaling that produces diminishing returns at higher loads.
 */
export class StrainScore {
  static readonly #SCALE_FACTOR = 3.5;
  static readonly #MAX = 21;

  constructor(readonly value: number) {}

  get color(): string {
    if (this.value > 17) return statusColors.danger;
    if (this.value >= 14) return statusColors.warning;
    if (this.value >= 10) return statusColors.positive;
    return textColors.secondary;
  }

  get label(): string {
    if (this.value > 17) return "All Out";
    if (this.value >= 14) return "High";
    if (this.value >= 10) return "Moderate";
    return "Light";
  }

  static fromRawLoad(rawLoad: number): StrainScore {
    if (rawLoad <= 0) return new StrainScore(0);
    const strain = StrainScore.#SCALE_FACTOR * Math.log(1 + rawLoad);
    const value = Math.round(Math.min(strain, StrainScore.#MAX) * 10) / 10;
    return new StrainScore(value);
  }
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

/** Strain zone classification with display properties. */
export class StrainZone {
  constructor(readonly zone: string) {}

  get color(): string {
    if (this.zone === "optimal") return statusColors.positive;
    if (this.zone === "overreaching") return statusColors.danger;
    if (this.zone === "restoring") return statusColors.info;
    return textColors.secondary;
  }

  get label(): string {
    if (this.zone === "optimal") return "Optimal";
    if (this.zone === "overreaching") return "Overreaching";
    if (this.zone === "restoring") return "Restoring";
    return this.zone;
  }
}

/** Workload ratio (ACWR) with display classification. */
export class WorkloadRatio {
  constructor(readonly value: number | null) {}

  get color(): string {
    if (this.value == null) return textColors.secondary;
    if (this.value >= 0.8 && this.value <= 1.3) return statusColors.positive;
    if (this.value >= 0.5 && this.value <= 1.5) return statusColors.warning;
    return statusColors.danger;
  }

  get hint(): string | null {
    if (this.value == null) return null;
    if (this.value >= 0.8 && this.value <= 1.3) return "Optimal training zone";
    if (this.value < 0.8) return "Detraining risk - increase load gradually";
    if (this.value <= 1.5) return "High load - monitor recovery closely";
    return "Injury risk zone - consider rest";
  }
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

/** Stress score (0-3 Whoop-like scale) with display classification. */
export class StressScore {
  constructor(readonly value: number) {}

  get color(): string {
    if (this.value <= 0.5) return statusColors.positive;
    if (this.value <= 1.5) return statusColors.warning;
    if (this.value <= 2.5) return statusColors.elevated;
    return statusColors.danger;
  }

  get label(): string {
    if (this.value <= 0.5) return "Low";
    if (this.value <= 1.5) return "Moderate";
    if (this.value <= 2.5) return "High";
    return "Very High";
  }
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

/**
 * Map a z-score to a 0-100 recovery score using an asymmetric sigmoid.
 * Tuned to match Whoop's recovery scoring:
 *   z=0 (at baseline mean) → 62 (average day feels "recovered")
 *   z=+1 → ~80, z=-1 → ~40
 *   z=+2 → ~93, z=-2 → ~18
 * Uses separate scales for positive/negative z to handle the asymmetric center.
 */
export function zScoreToRecoveryScore(zScore: number): number {
  const center = 62;
  const sigmoidSteepness = 1.1;
  const sigmoid = 1 / (1 + Math.exp(-zScore * sigmoidSteepness));
  const scaleUp = 100 - center; // 38: maps sigmoid 0.5→1.0 to 62→100
  const scaleDown = center; // 62: maps sigmoid 0.0→0.5 to 0→62
  const score =
    sigmoid >= 0.5
      ? center + scaleUp * ((sigmoid - 0.5) / 0.5)
      : center - scaleDown * ((0.5 - sigmoid) / 0.5);
  return Math.max(0, Math.min(100, Math.round(score)));
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

/** Form zone (training stress balance) classification with display properties. */
export class FormZone {
  constructor(readonly value: number) {}

  get color(): string {
    if (this.value > FORM_ZONE_TRANSITION) return FORM_ZONE_COLORS.transition;
    if (this.value > FORM_ZONE_FRESH) return FORM_ZONE_COLORS.fresh;
    if (this.value > FORM_ZONE_GREY) return FORM_ZONE_COLORS.grey;
    if (this.value > FORM_ZONE_OPTIMAL) return FORM_ZONE_COLORS.optimal;
    return FORM_ZONE_COLORS.highRisk;
  }

  get label(): string {
    if (this.value > FORM_ZONE_TRANSITION) return "Transition";
    if (this.value > FORM_ZONE_FRESH) return "Fresh";
    if (this.value > FORM_ZONE_GREY) return "Grey Zone";
    if (this.value > FORM_ZONE_OPTIMAL) return "Optimal";
    return "High Risk";
  }
}
