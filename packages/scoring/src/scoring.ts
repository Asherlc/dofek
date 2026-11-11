import { statusColors, textColors } from "./colors.ts";

/** Shared presentation thresholds for retained 0–100 score displays. */
export const SCORE_WARNING_THRESHOLD = 50;
export const SCORE_RECOVERED_THRESHOLD = 70;

export interface ScoreZone {
  /** Lower bound (inclusive) */
  min: number;
  /** Upper bound (inclusive for charting) */
  max: number;
  status: "danger" | "warning" | "positive";
}

/** Visual score zones used by charts and cards to keep threshold bands consistent. */
export const SCORE_ZONES: ScoreZone[] = [
  { min: 0, max: SCORE_WARNING_THRESHOLD, status: "danger" },
  { min: SCORE_WARNING_THRESHOLD, max: SCORE_RECOVERED_THRESHOLD, status: "warning" },
  { min: SCORE_RECOVERED_THRESHOLD, max: 100, status: "positive" },
];

export function scoreColor(score: number): string {
  if (score > SCORE_RECOVERED_THRESHOLD) return statusColors.positive;
  if (score >= SCORE_WARNING_THRESHOLD) return statusColors.warning;
  return statusColors.danger;
}

/** Get a presentation label for a 0–100 score. */
export function scoreLabel(score: number): string {
  if (score > SCORE_RECOVERED_THRESHOLD) return "Recovered";
  if (score >= SCORE_WARNING_THRESHOLD) return "Moderate";
  return "Poor";
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
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }

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

/** Get the color for a health metric status (excellent/good/fair/poor) */
export function healthStatusColor(status: "excellent" | "good" | "fair" | "poor"): string {
  if (status === "excellent") return statusColors.positive;
  if (status === "good") return statusColors.info;
  if (status === "fair") return statusColors.warning;
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
  fresh: statusColors.positive,
  grey: "#a1a1aa",
  optimal: statusColors.positive,
  highRisk: statusColors.danger,
} as const;

/** Form zone (training stress balance) classification with display properties. */
export class FormZone {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }

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
