/**
 * Pure scoring functions for Healthspan metrics.
 *
 * Each metric is scored 0-100 based on age/gender-adjusted percentiles from
 * published health research. See ./healthspan.ts for the full 9-metric list.
 */

export type HealthspanStatus = "excellent" | "good" | "fair" | "poor";

export function scoreToStatus(score: number): HealthspanStatus {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "fair";
  return "poor";
}

/** Score sleep consistency: lower stddev of bedtime = better. <30min stddev = 100 */
export function scoreSleepConsistency(stddevMinutes: number | null): number {
  if (stddevMinutes == null) return 50;
  // 0 stddev = 100, 90+ min stddev = 0
  return Math.max(0, Math.min(100, Math.round(100 - (stddevMinutes / 90) * 100)));
}

/** Score average sleep duration. Optimal is 7-9 hours. */
export function scoreSleepDuration(avgMinutes: number | null): number {
  if (avgMinutes == null) return 50;
  const hours = avgMinutes / 60;
  if (hours >= 7 && hours <= 9) return 100;
  if (hours >= 6 && hours < 7) return 70;
  if (hours >= 9 && hours < 10) return 80;
  if (hours >= 5 && hours < 6) return 40;
  return 20;
}

/** Score aerobic zone time (zones 1-3). WHO recommends 150-300 min/week. */
export function scoreAerobicMinutes(weeklyMin: number | null): number {
  if (weeklyMin == null) return 50;
  if (weeklyMin >= 300) return 100;
  if (weeklyMin >= 150) return 70 + ((weeklyMin - 150) / 150) * 30;
  if (weeklyMin >= 75) return 40 + ((weeklyMin - 75) / 75) * 30;
  return Math.round((weeklyMin / 75) * 40);
}

/** Score high-intensity zone time (zones 4-5). WHO recommends 75-150 min/week vigorous. */
export function scoreHighIntensityMinutes(weeklyMin: number | null): number {
  if (weeklyMin == null) return 50;
  if (weeklyMin >= 150) return 100;
  if (weeklyMin >= 75) return 70 + ((weeklyMin - 75) / 75) * 30;
  if (weeklyMin >= 30) return 40 + ((weeklyMin - 30) / 45) * 30;
  return Math.round((weeklyMin / 30) * 40);
}

/** Score strength training frequency. 2-4 sessions/week is optimal. */
export function scoreStrengthFrequency(sessionsPerWeek: number | null): number {
  if (sessionsPerWeek == null) return 50;
  if (sessionsPerWeek >= 2 && sessionsPerWeek <= 5) return 100;
  if (sessionsPerWeek >= 1) return 70;
  return 20;
}

/** Score daily steps. 8000-12000 is optimal per longevity research. */
export function scoreSteps(dailyAvg: number | null): number {
  if (dailyAvg == null) return 50;
  if (dailyAvg >= 10000) return 100;
  if (dailyAvg >= 8000) return 85;
  if (dailyAvg >= 6000) return 65;
  if (dailyAvg >= 4000) return 45;
  return Math.round((dailyAvg / 4000) * 45);
}

/** Score VO2 max. Higher is better. Age-adjusted would be ideal but we use general thresholds. */
export function scoreVo2Max(vo2max: number | null): number {
  if (vo2max == null) return 50;
  if (vo2max >= 50) return 100;
  if (vo2max >= 45) return 85;
  if (vo2max >= 40) return 70;
  if (vo2max >= 35) return 55;
  if (vo2max >= 30) return 40;
  return 20;
}

/** Score resting HR. Lower is better. Elite athletes: 40-50, good: 50-65, avg: 65-75. */
export function scoreRestingHr(rhr: number | null): number {
  if (rhr == null) return 50;
  if (rhr <= 50) return 100;
  if (rhr <= 55) return 90;
  if (rhr <= 60) return 80;
  if (rhr <= 65) return 65;
  if (rhr <= 70) return 50;
  if (rhr <= 75) return 35;
  return 20;
}

/** Score lean body mass percentage. Higher lean mass = better for longevity. */
export function scoreLeanMassPct(leanPct: number | null): number {
  if (leanPct == null) return 50;
  // Rough thresholds (gender-neutral)
  if (leanPct >= 85) return 100;
  if (leanPct >= 80) return 85;
  if (leanPct >= 75) return 70;
  if (leanPct >= 70) return 55;
  return 35;
}
