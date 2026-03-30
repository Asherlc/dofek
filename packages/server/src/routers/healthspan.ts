import { scoreToYearsDelta } from "@dofek/scoring/healthspan-years";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowStart, endDateSchema, timestampWindowStart } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

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
 * Each metric is scored 0-100 based on age/gender-adjusted percentiles from
 * published health research. The composite produces a biological age delta.
 */

export interface HealthspanMetric {
  name: string;
  value: number | null;
  unit: string;
  score: number;
  /** Brief interpretation */
  status: "excellent" | "good" | "fair" | "poor";
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

export function scoreToStatus(score: number): "excellent" | "good" | "fair" | "poor" {
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

export const healthspanRouter = router({
  /**
   * Healthspan Score — composite longevity metric inspired by Whoop's Healthspan.
   * Updates weekly from rolling 4-week data windows.
   */
  score: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ weeks: z.number().min(4).max(52).default(12), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<HealthspanResult> => {
      const totalDays = input.weeks * 7;

      const histRowSchema = z.object({
        week_start: dateStringSchema,
        avg_rhr: z.coerce.number().nullable(),
        avg_steps: z.coerce.number().nullable(),
        avg_vo2max: z.coerce.number().nullable(),
      });

      const rawRowSchema = z.object({
        avg_sleep_min: z.coerce.number().nullable(),
        bedtime_stddev_min: z.coerce.number().nullable(),
        avg_resting_hr: z.coerce.number().nullable(),
        avg_steps: z.coerce.number().nullable(),
        latest_vo2max: z.coerce.number().nullable(),
        weekly_aerobic_min: z.coerce.number().nullable(),
        weekly_high_intensity_min: z.coerce.number().nullable(),
        sessions_per_week: z.coerce.number().nullable(),
        weight_kg: z.coerce.number().nullable(),
        body_fat_pct: z.coerce.number().nullable(),
        weekly_history: z.array(histRowSchema).nullable(),
      });

      // Fetch all needed data in one query (aggregates + weekly history via JSON)
      const rows = await executeWithSchema(
        ctx.db,
        rawRowSchema,
        sql`WITH sleep_data AS (
              SELECT
                (started_at AT TIME ZONE ${ctx.timezone})::date AS date,
                duration_minutes,
                EXTRACT(HOUR FROM started_at AT TIME ZONE ${ctx.timezone}) * 60 + EXTRACT(MINUTE FROM started_at AT TIME ZONE ${ctx.timezone}) AS bedtime_minutes
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > ${timestampWindowStart(input.endDate, totalDays)}
            ),
            sleep_agg AS (
              SELECT
                AVG(duration_minutes) AS avg_sleep_min,
                STDDEV_POP(bedtime_minutes) AS bedtime_stddev_min
              FROM sleep_data
            ),
            metrics_agg AS (
              SELECT
                AVG(resting_hr) AS avg_resting_hr,
                AVG(steps) AS avg_steps,
                (SELECT vo2max FROM fitness.v_daily_metrics
                 WHERE user_id = ${ctx.userId} AND vo2max IS NOT NULL
                 ORDER BY date DESC LIMIT 1) AS latest_vo2max
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > ${dateWindowStart(input.endDate, totalDays)}
            ),
            hr_zone_time AS (
              SELECT
                COALESCE(SUM(
                  CASE WHEN up3.max_hr IS NOT NULL AND rhr2.resting_hr IS NOT NULL
                       AND asum.hr_sample_count > 0 AND asum.ended_at IS NOT NULL
                  THEN
                    cnt.aerobic_count::real / asum.hr_sample_count::real
                    * EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                  ELSE 0 END
                ), 0) AS aerobic_minutes,
                COALESCE(SUM(
                  CASE WHEN up3.max_hr IS NOT NULL AND rhr2.resting_hr IS NOT NULL
                       AND asum.hr_sample_count > 0 AND asum.ended_at IS NOT NULL
                  THEN
                    cnt.hi_count::real / asum.hr_sample_count::real
                    * EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                  ELSE 0 END
                ), 0) AS high_intensity_minutes
              FROM fitness.activity_summary asum
              JOIN fitness.user_profile up3 ON up3.id = asum.user_id
              JOIN LATERAL (
                SELECT dm2.resting_hr
                FROM fitness.v_daily_metrics dm2
                WHERE dm2.user_id = asum.user_id
                  AND dm2.date <= (asum.started_at AT TIME ZONE ${ctx.timezone})::date
                  AND dm2.resting_hr IS NOT NULL
                ORDER BY dm2.date DESC LIMIT 1
              ) rhr2 ON true
              JOIN LATERAL (
                SELECT
                  COUNT(*) FILTER (WHERE ms2.heart_rate < rhr2.resting_hr + (up3.max_hr - rhr2.resting_hr) * 0.8) AS aerobic_count,
                  COUNT(*) FILTER (WHERE ms2.heart_rate >= rhr2.resting_hr + (up3.max_hr - rhr2.resting_hr) * 0.8) AS hi_count
                FROM fitness.metric_stream ms2
                WHERE ms2.activity_id = asum.activity_id
                  AND ms2.heart_rate IS NOT NULL
              ) cnt ON true
              WHERE asum.user_id = ${ctx.userId}
                AND asum.started_at > ${timestampWindowStart(input.endDate, totalDays)}
                AND asum.hr_sample_count > 0
                AND up3.max_hr IS NOT NULL
            ),
            strength_freq AS (
              SELECT NULLIF(COUNT(*), 0)::real / GREATEST(${totalDays}::real / 7, 1) AS sessions_per_week
              FROM fitness.strength_workout
              WHERE user_id = ${ctx.userId}
                AND started_at > ${timestampWindowStart(input.endDate, totalDays)}
            ),
            body_latest AS (
              SELECT weight_kg, body_fat_pct
              FROM fitness.v_body_measurement
              WHERE user_id = ${ctx.userId}
                AND weight_kg IS NOT NULL
              ORDER BY recorded_at DESC
              LIMIT 1
            ),
            weekly_metrics AS (
              SELECT
                date_trunc('week', date)::date AS week_start,
                AVG(resting_hr) AS avg_rhr,
                AVG(steps) AS avg_steps,
                AVG(vo2max) AS avg_vo2max
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > ${dateWindowStart(input.endDate, totalDays)}
              GROUP BY date_trunc('week', date)
              ORDER BY week_start ASC
            )
            SELECT
              sa.avg_sleep_min,
              sa.bedtime_stddev_min,
              ma.avg_resting_hr,
              ma.avg_steps,
              ma.latest_vo2max,
              hz.aerobic_minutes / GREATEST(${totalDays}::real / 7, 1) AS weekly_aerobic_min,
              hz.high_intensity_minutes / GREATEST(${totalDays}::real / 7, 1) AS weekly_high_intensity_min,
              sf.sessions_per_week,
              bl.weight_kg,
              bl.body_fat_pct,
              (SELECT json_agg(json_build_object(
                'week_start', wm.week_start::text,
                'avg_rhr', wm.avg_rhr,
                'avg_steps', wm.avg_steps,
                'avg_vo2max', wm.avg_vo2max
              ) ORDER BY wm.week_start ASC) FROM weekly_metrics wm) AS weekly_history
            FROM sleep_agg sa
            CROSS JOIN metrics_agg ma
            CROSS JOIN hr_zone_time hz
            CROSS JOIN strength_freq sf
            LEFT JOIN body_latest bl ON true`,
      );

      const row = rows[0];
      if (!row) {
        return {
          healthspanScore: null,
          yearsDelta: null,
          metrics: [],
          history: [],
          trend: null,
        };
      }

      // Compute lean mass percentage
      const leanMassPct = row.body_fat_pct != null ? 100 - Number(row.body_fat_pct) : null;

      // Score each metric
      const metricDefs: HealthspanMetric[] = [
        {
          name: "Sleep Consistency",
          value: row.bedtime_stddev_min != null ? Math.round(Number(row.bedtime_stddev_min)) : null,
          unit: "min stddev",
          score: scoreSleepConsistency(
            row.bedtime_stddev_min != null ? Number(row.bedtime_stddev_min) : null,
          ),
          status: "good",
          yearsDelta: 0,
        },
        {
          name: "Sleep Duration",
          value: row.avg_sleep_min != null ? Math.round(Number(row.avg_sleep_min)) : null,
          unit: "min/night",
          score: scoreSleepDuration(row.avg_sleep_min != null ? Number(row.avg_sleep_min) : null),
          status: "good",
          yearsDelta: 0,
        },
        {
          name: "Aerobic Activity",
          value: row.weekly_aerobic_min != null ? Math.round(Number(row.weekly_aerobic_min)) : null,
          unit: "min/week",
          score: scoreAerobicMinutes(
            row.weekly_aerobic_min != null ? Number(row.weekly_aerobic_min) : null,
          ),
          status: "good",
          yearsDelta: 0,
        },
        {
          name: "High Intensity",
          value:
            row.weekly_high_intensity_min != null
              ? Math.round(Number(row.weekly_high_intensity_min))
              : null,
          unit: "min/week",
          score: scoreHighIntensityMinutes(
            row.weekly_high_intensity_min != null ? Number(row.weekly_high_intensity_min) : null,
          ),
          status: "good",
          yearsDelta: 0,
        },
        {
          name: "Strength Training",
          value:
            row.sessions_per_week != null
              ? Math.round(Number(row.sessions_per_week) * 10) / 10
              : null,
          unit: "sessions/week",
          score: scoreStrengthFrequency(
            row.sessions_per_week != null ? Number(row.sessions_per_week) : null,
          ),
          status: "good",
          yearsDelta: 0,
        },
        {
          name: "Daily Steps",
          value: row.avg_steps != null ? Math.round(Number(row.avg_steps)) : null,
          unit: "steps/day",
          score: scoreSteps(row.avg_steps != null ? Number(row.avg_steps) : null),
          status: "good",
          yearsDelta: 0,
        },
        {
          name: "VO2 Max",
          value: row.latest_vo2max != null ? Math.round(Number(row.latest_vo2max) * 10) / 10 : null,
          unit: "mL/kg/min",
          score: scoreVo2Max(row.latest_vo2max != null ? Number(row.latest_vo2max) : null),
          status: "good",
          yearsDelta: 0,
        },
        {
          name: "Resting Heart Rate",
          value:
            row.avg_resting_hr != null ? Math.round(Number(row.avg_resting_hr) * 10) / 10 : null,
          unit: "bpm",
          score: scoreRestingHr(row.avg_resting_hr != null ? Number(row.avg_resting_hr) : null),
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

      // Set status and yearsDelta based on score
      for (const m of metricDefs) {
        m.status = scoreToStatus(m.score);
        m.yearsDelta = scoreToYearsDelta(m.score);
      }

      // Composite: equal weight across metrics that have real data.
      // Require at least 3 metrics — fewer than that is not a meaningful composite.
      const metricsWithData = metricDefs.filter((m) => m.value != null);
      const healthspanScore =
        metricsWithData.length >= 3
          ? Math.round(
              metricsWithData.reduce((sum, m) => sum + m.score, 0) / metricsWithData.length,
            )
          : null;

      // Weekly scores from the subset of metrics that aggregate weekly
      // (resting heart rate, steps, VO2 max — 3 of 9 total metrics)
      const weeklyHistory = row.weekly_history ?? [];
      const history = weeklyHistory.map((h) => {
        const rhrScore = scoreRestingHr(h.avg_rhr != null ? Number(h.avg_rhr) : null);
        const stepsScore = scoreSteps(h.avg_steps != null ? Number(h.avg_steps) : null);
        const vo2Score = scoreVo2Max(h.avg_vo2max != null ? Number(h.avg_vo2max) : null);
        const weekScore = Math.round((rhrScore + stepsScore + vo2Score) / 3);
        return { weekStart: h.week_start, score: weekScore };
      });

      // Trend direction from linear regression slope of weekly scores
      let trend: "improving" | "declining" | "stable" | null = null;
      if (history.length >= 4) {
        const weekCount = history.length;
        const xMean = (weekCount - 1) / 2;
        const yMean = history.reduce((s, h) => s + h.score, 0) / weekCount;
        let num = 0;
        let den = 0;
        for (let i = 0; i < weekCount; i++) {
          const score = history[i]?.score ?? 0;
          num += (i - xMean) * (score - yMean);
          den += (i - xMean) * (i - xMean);
        }
        const slope = den > 0 ? num / den : 0;
        // Threshold: ±0.5 points per week to count as improving/declining
        if (slope > 0.5) trend = "improving";
        else if (slope < -0.5) trend = "declining";
        else trend = "stable";
      }

      return {
        healthspanScore,
        yearsDelta: healthspanScore != null ? scoreToYearsDelta(healthspanScore) : null,
        metrics: metricDefs,
        history,
        trend,
      };
    }),
});
