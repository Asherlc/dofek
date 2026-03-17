import { colors } from "../theme";

/** Get the color for a recovery/readiness score (0-100) */
export function scoreColor(score: number): string {
  if (score >= 67) return colors.positive;
  if (score >= 34) return colors.warning;
  return colors.danger;
}

/** Get a human-readable label for a recovery score (0-100) */
export function scoreLabel(score: number): string {
  if (score >= 67) return "Recovered";
  if (score >= 34) return "Moderate";
  return "Poor";
}

/** Get the color for a workload ratio value */
export function workloadRatioColor(ratio: number | null): string {
  if (ratio == null) return colors.textSecondary;
  if (ratio >= 0.8 && ratio <= 1.3) return colors.positive;
  if (ratio >= 0.5 && ratio <= 1.5) return colors.warning;
  return colors.danger;
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
export function aggregateWeeklyVolume(
  rows: Array<{ week: string; hours: number }>,
): WeekSummary[] {
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
export function trendDirection(
  current: number,
  previous: number,
): "up" | "down" | "stable" {
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "stable";
}
