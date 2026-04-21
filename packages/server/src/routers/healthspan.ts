import { scoreToYearsDelta } from "@dofek/scoring/healthspan-years";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";
import { fetchHealthspanRawData, type HealthspanRawRow } from "./healthspan-query.ts";
import {
  type HealthspanStatus,
  scoreAerobicMinutes,
  scoreHighIntensityMinutes,
  scoreLeanMassPct,
  scoreRestingHr,
  scoreSleepConsistency,
  scoreSleepDuration,
  scoreSteps,
  scoreStrengthFrequency,
  scoreToStatus,
  scoreVo2Max,
} from "./healthspan-scoring.ts";

/**
 * Whoop's Healthspan tracks 9 metrics to produce a biological age and pace of aging.
 * We replicate this with the data we have:
 *
 * 1. Sleep consistency (stddev of bedtime)
 * 2. Hours of sleep (avg)
 * 3. Time in HR zones 1-3 (aerobic, weekly minutes)
 * 4. Time in HR zones 4-5 (high intensity, weekly minutes)
 * 5. Strength training frequency (sessions/week)
 * 6. Steps (daily average)
 * 7. VO2 Max (latest)
 * 8. Resting Heart Rate (avg)
 * 9. Lean Body Mass — approximated from weight + body fat %
 *
 * Scoring lives in ./healthspan-scoring.ts. The raw SQL query lives in
 * ./healthspan-query.ts.
 */

export interface HealthspanMetric {
  name: string;
  value: number | null;
  unit: string;
  score: number;
  /** Brief interpretation */
  status: HealthspanStatus;
  /** Biological age delta in years for this metric alone */
  yearsDelta: number;
}

export interface HealthspanResult {
  /** Composite healthspan score 0-100, or null when there is no data */
  healthspanScore: number | null;
  /** Composite biological age delta in years, or null when no score */
  yearsDelta: number | null;
  /** Individual metric breakdowns */
  metrics: HealthspanMetric[];
  /** Historical weekly scores derived from resting heart rate, steps, and VO2 max only */
  history: { weekStart: string; score: number }[];
  /** Direction of weekly score trend: "improving" | "declining" | "stable" (null if < 4 weeks of data) */
  trend: "improving" | "declining" | "stable" | null;
}

function toNumberOrNull(value: number | null): number | null {
  return value != null ? Number(value) : null;
}

function buildMetrics(row: HealthspanRawRow): HealthspanMetric[] {
  const leanMassPct = row.body_fat_pct != null ? 100 - Number(row.body_fat_pct) : null;

  const bedtimeStddev = toNumberOrNull(row.bedtime_stddev_min);
  const avgSleepMin = toNumberOrNull(row.avg_sleep_min);
  const weeklyAerobic = toNumberOrNull(row.weekly_aerobic_min);
  const weeklyHighIntensity = toNumberOrNull(row.weekly_high_intensity_min);
  const sessionsPerWeek = toNumberOrNull(row.sessions_per_week);
  const avgSteps = toNumberOrNull(row.avg_steps);
  const latestVo2max = toNumberOrNull(row.latest_vo2max);
  const avgRestingHr = toNumberOrNull(row.avg_resting_hr);

  const metrics: HealthspanMetric[] = [
    {
      name: "Sleep Consistency",
      value: bedtimeStddev != null ? Math.round(bedtimeStddev) : null,
      unit: "min stddev",
      score: scoreSleepConsistency(bedtimeStddev),
      status: "good",
      yearsDelta: 0,
    },
    {
      name: "Sleep Duration",
      value: avgSleepMin != null ? Math.round(avgSleepMin) : null,
      unit: "min/night",
      score: scoreSleepDuration(avgSleepMin),
      status: "good",
      yearsDelta: 0,
    },
    {
      name: "Aerobic Activity",
      value: weeklyAerobic != null ? Math.round(weeklyAerobic) : null,
      unit: "min/week",
      score: scoreAerobicMinutes(weeklyAerobic),
      status: "good",
      yearsDelta: 0,
    },
    {
      name: "High Intensity",
      value: weeklyHighIntensity != null ? Math.round(weeklyHighIntensity) : null,
      unit: "min/week",
      score: scoreHighIntensityMinutes(weeklyHighIntensity),
      status: "good",
      yearsDelta: 0,
    },
    {
      name: "Strength Training",
      value: sessionsPerWeek != null ? Math.round(sessionsPerWeek * 10) / 10 : null,
      unit: "sessions/week",
      score: scoreStrengthFrequency(sessionsPerWeek),
      status: "good",
      yearsDelta: 0,
    },
    {
      name: "Daily Steps",
      value: avgSteps != null ? Math.round(avgSteps) : null,
      unit: "steps/day",
      score: scoreSteps(avgSteps),
      status: "good",
      yearsDelta: 0,
    },
    {
      name: "VO2 Max",
      value: latestVo2max != null ? Math.round(latestVo2max * 10) / 10 : null,
      unit: "mL/kg/min",
      score: scoreVo2Max(latestVo2max),
      status: "good",
      yearsDelta: 0,
    },
    {
      name: "Resting Heart Rate",
      value: avgRestingHr != null ? Math.round(avgRestingHr * 10) / 10 : null,
      unit: "bpm",
      score: scoreRestingHr(avgRestingHr),
      status: "good",
      yearsDelta: 0,
    },
    {
      name: "Lean Body Mass",
      value: leanMassPct != null ? Math.round(leanMassPct * 10) / 10 : null,
      unit: "%",
      score: scoreLeanMassPct(leanMassPct),
      status: "good",
      yearsDelta: 0,
    },
  ];

  for (const metric of metrics) {
    metric.status = scoreToStatus(metric.score);
    metric.yearsDelta = scoreToYearsDelta(metric.score);
  }

  return metrics;
}

/**
 * Weekly scores from the subset of metrics that aggregate weekly
 * (resting heart rate, steps, VO2 max — 3 of 9 total metrics).
 */
function buildHistory(row: HealthspanRawRow): HealthspanResult["history"] {
  return (row.weekly_history ?? []).map((week) => {
    const rhrScore = scoreRestingHr(week.avg_rhr != null ? Number(week.avg_rhr) : null);
    const stepsScore = scoreSteps(week.avg_steps != null ? Number(week.avg_steps) : null);
    const vo2Score = scoreVo2Max(week.avg_vo2max != null ? Number(week.avg_vo2max) : null);
    return {
      weekStart: week.week_start,
      score: Math.round((rhrScore + stepsScore + vo2Score) / 3),
    };
  });
}

/** Linear regression slope of weekly scores, bucketed into a direction. */
function computeTrend(history: HealthspanResult["history"]): HealthspanResult["trend"] {
  if (history.length < 4) return null;

  const weekCount = history.length;
  const xMean = (weekCount - 1) / 2;
  const yMean = history.reduce((sum, week) => sum + week.score, 0) / weekCount;

  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < weekCount; index++) {
    const score = history[index]?.score ?? 0;
    numerator += (index - xMean) * (score - yMean);
    denominator += (index - xMean) * (index - xMean);
  }
  const slope = denominator > 0 ? numerator / denominator : 0;

  // Threshold: ±0.5 points per week to count as improving/declining
  if (slope > 0.5) return "improving";
  if (slope < -0.5) return "declining";
  return "stable";
}

export const healthspanRouter = router({
  /**
   * Healthspan Score — composite longevity metric inspired by Whoop's Healthspan.
   * Updates weekly from rolling 4-week data windows.
   */
  score: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ weeks: z.number().min(4).max(52).default(12), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<HealthspanResult> => {
      const totalDays = input.weeks * 7;

      const row = await fetchHealthspanRawData(ctx, input.endDate, totalDays);
      if (!row) {
        return {
          healthspanScore: null,
          yearsDelta: null,
          metrics: [],
          history: [],
          trend: null,
        };
      }

      const metrics = buildMetrics(row);

      // Composite: equal weight across metrics that have real data.
      // Require at least 3 metrics — fewer than that is not a meaningful composite.
      const metricsWithData = metrics.filter((metric) => metric.value != null);
      const healthspanScore =
        metricsWithData.length >= 3
          ? Math.round(
              metricsWithData.reduce((sum, metric) => sum + metric.score, 0) /
                metricsWithData.length,
            )
          : null;

      const history = buildHistory(row);

      return {
        healthspanScore,
        yearsDelta: healthspanScore != null ? scoreToYearsDelta(healthspanScore) : null,
        metrics,
        history,
        trend: computeTrend(history),
      };
    }),
});
