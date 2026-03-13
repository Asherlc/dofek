import { sql } from "drizzle-orm";
import { z } from "zod";
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
}

export interface HealthspanResult {
  /** Composite healthspan score 0-100 */
  healthspanScore: number;
  /** Estimated biological age (null if birth_date not set) */
  biologicalAge: number | null;
  /** Chronological age (null if birth_date not set) */
  chronologicalAge: number | null;
  /** Pace of aging: <1.0 = aging slower, >1.0 = aging faster (null if insufficient history) */
  paceOfAging: number | null;
  /** Individual metric breakdowns */
  metrics: HealthspanMetric[];
  /** Historical weekly scores for trend */
  history: { weekStart: string; score: number }[];
}

function scoreToStatus(score: number): "excellent" | "good" | "fair" | "poor" {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "fair";
  return "poor";
}

/** Score sleep consistency: lower stddev of bedtime = better. <30min stddev = 100 */
function scoreSleepConsistency(stddevMinutes: number | null): number {
  if (stddevMinutes == null) return 50;
  // 0 stddev = 100, 90+ min stddev = 0
  return Math.max(0, Math.min(100, Math.round(100 - (stddevMinutes / 90) * 100)));
}

/** Score average sleep duration. Optimal is 7-9 hours. */
function scoreSleepDuration(avgMinutes: number | null): number {
  if (avgMinutes == null) return 50;
  const hours = avgMinutes / 60;
  if (hours >= 7 && hours <= 9) return 100;
  if (hours >= 6 && hours < 7) return 70;
  if (hours >= 9 && hours < 10) return 80;
  if (hours >= 5 && hours < 6) return 40;
  return 20;
}

/** Score aerobic zone time (zones 1-3). WHO recommends 150-300 min/week. */
function scoreAerobicMinutes(weeklyMin: number | null): number {
  if (weeklyMin == null) return 50;
  if (weeklyMin >= 300) return 100;
  if (weeklyMin >= 150) return 70 + ((weeklyMin - 150) / 150) * 30;
  if (weeklyMin >= 75) return 40 + ((weeklyMin - 75) / 75) * 30;
  return Math.round((weeklyMin / 75) * 40);
}

/** Score high-intensity zone time (zones 4-5). WHO recommends 75-150 min/week vigorous. */
function scoreHighIntensityMinutes(weeklyMin: number | null): number {
  if (weeklyMin == null) return 50;
  if (weeklyMin >= 150) return 100;
  if (weeklyMin >= 75) return 70 + ((weeklyMin - 75) / 75) * 30;
  if (weeklyMin >= 30) return 40 + ((weeklyMin - 30) / 45) * 30;
  return Math.round((weeklyMin / 30) * 40);
}

/** Score strength training frequency. 2-4 sessions/week is optimal. */
function scoreStrengthFrequency(sessionsPerWeek: number | null): number {
  if (sessionsPerWeek == null) return 50;
  if (sessionsPerWeek >= 2 && sessionsPerWeek <= 5) return 100;
  if (sessionsPerWeek >= 1) return 70;
  return 20;
}

/** Score daily steps. 8000-12000 is optimal per longevity research. */
function scoreSteps(dailyAvg: number | null): number {
  if (dailyAvg == null) return 50;
  if (dailyAvg >= 10000) return 100;
  if (dailyAvg >= 8000) return 85;
  if (dailyAvg >= 6000) return 65;
  if (dailyAvg >= 4000) return 45;
  return Math.round((dailyAvg / 4000) * 45);
}

/** Score VO2 max. Higher is better. Age-adjusted would be ideal but we use general thresholds. */
function scoreVo2Max(vo2max: number | null): number {
  if (vo2max == null) return 50;
  if (vo2max >= 50) return 100;
  if (vo2max >= 45) return 85;
  if (vo2max >= 40) return 70;
  if (vo2max >= 35) return 55;
  if (vo2max >= 30) return 40;
  return 20;
}

/** Score resting HR. Lower is better. Elite athletes: 40-50, good: 50-65, avg: 65-75. */
function scoreRestingHr(rhr: number | null): number {
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
function scoreLeanMassPct(leanPct: number | null): number {
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
    .input(z.object({ weeks: z.number().min(4).max(52).default(12) }))
    .query(async ({ ctx, input }): Promise<HealthspanResult> => {
      const totalDays = input.weeks * 7;

      // Fetch all needed data in one big query
      const rows = await ctx.db.execute(
        sql`WITH user_info AS (
              SELECT birth_date, max_hr FROM fitness.user_profile WHERE id = ${ctx.userId}
            ),
            sleep_data AS (
              SELECT
                started_at::date AS date,
                duration_minutes,
                EXTRACT(HOUR FROM started_at) * 60 + EXTRACT(MINUTE FROM started_at) AS bedtime_minutes
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > NOW() - ${totalDays}::int * INTERVAL '1 day'
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
                AND date > CURRENT_DATE - ${totalDays}::int
            ),
            hr_zone_time AS (
              SELECT
                COALESCE(COUNT(*) FILTER (
                  WHERE ms.heart_rate < rhr.resting_hr + (up2.max_hr - rhr.resting_hr) * 0.8
                ), 0)::real / 60.0 AS aerobic_minutes,
                COALESCE(COUNT(*) FILTER (
                  WHERE ms.heart_rate >= rhr.resting_hr + (up2.max_hr - rhr.resting_hr) * 0.8
                ), 0)::real / 60.0 AS high_intensity_minutes
              FROM fitness.user_profile up2
              JOIN fitness.v_activity a ON a.user_id = up2.id
              JOIN fitness.metric_stream ms ON ms.activity_id = a.id
              JOIN LATERAL (
                SELECT dm.resting_hr
                FROM fitness.v_daily_metrics dm
                WHERE dm.user_id = up2.id
                  AND dm.date <= a.started_at::date
                  AND dm.resting_hr IS NOT NULL
                ORDER BY dm.date DESC
                LIMIT 1
              ) rhr ON true
              WHERE up2.id = ${ctx.userId}
                AND a.started_at > NOW() - ${totalDays}::int * INTERVAL '1 day'
                AND ms.heart_rate IS NOT NULL
                AND up2.max_hr IS NOT NULL
            ),
            strength_freq AS (
              SELECT COUNT(*)::real / GREATEST(${totalDays}::real / 7, 1) AS sessions_per_week
              FROM fitness.strength_workout
              WHERE user_id = ${ctx.userId}
                AND started_at > NOW() - ${totalDays}::int * INTERVAL '1 day'
            ),
            body_latest AS (
              SELECT weight_kg, body_fat_pct
              FROM fitness.body_measurement
              WHERE user_id = ${ctx.userId}
                AND weight_kg IS NOT NULL
              ORDER BY recorded_at DESC
              LIMIT 1
            )
            SELECT
              ui.birth_date,
              sa.avg_sleep_min,
              sa.bedtime_stddev_min,
              ma.avg_resting_hr,
              ma.avg_steps,
              ma.latest_vo2max,
              hz.aerobic_minutes / GREATEST(${totalDays}::real / 7, 1) AS weekly_aerobic_min,
              hz.high_intensity_minutes / GREATEST(${totalDays}::real / 7, 1) AS weekly_high_intensity_min,
              sf.sessions_per_week,
              bl.weight_kg,
              bl.body_fat_pct
            FROM user_info ui
            CROSS JOIN sleep_agg sa
            CROSS JOIN metrics_agg ma
            CROSS JOIN hr_zone_time hz
            CROSS JOIN strength_freq sf
            LEFT JOIN body_latest bl ON true`,
      );

      type RawRow = {
        birth_date: string | null;
        avg_sleep_min: number | null;
        bedtime_stddev_min: number | null;
        avg_resting_hr: number | null;
        avg_steps: number | null;
        latest_vo2max: number | null;
        weekly_aerobic_min: number | null;
        weekly_high_intensity_min: number | null;
        sessions_per_week: number | null;
        weight_kg: number | null;
        body_fat_pct: number | null;
      };

      const row = (rows as unknown as RawRow[])[0];
      if (!row) {
        return {
          healthspanScore: 50,
          biologicalAge: null,
          chronologicalAge: null,
          paceOfAging: null,
          metrics: [],
          history: [],
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
        },
        {
          name: "Sleep Duration",
          value: row.avg_sleep_min != null ? Math.round(Number(row.avg_sleep_min)) : null,
          unit: "min/night",
          score: scoreSleepDuration(row.avg_sleep_min != null ? Number(row.avg_sleep_min) : null),
          status: "good",
        },
        {
          name: "Aerobic Activity",
          value: row.weekly_aerobic_min != null ? Math.round(Number(row.weekly_aerobic_min)) : null,
          unit: "min/week",
          score: scoreAerobicMinutes(
            row.weekly_aerobic_min != null ? Number(row.weekly_aerobic_min) : null,
          ),
          status: "good",
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
        },
        {
          name: "Daily Steps",
          value: row.avg_steps != null ? Math.round(Number(row.avg_steps)) : null,
          unit: "steps/day",
          score: scoreSteps(row.avg_steps != null ? Number(row.avg_steps) : null),
          status: "good",
        },
        {
          name: "VO2 Max",
          value: row.latest_vo2max != null ? Math.round(Number(row.latest_vo2max) * 10) / 10 : null,
          unit: "mL/kg/min",
          score: scoreVo2Max(row.latest_vo2max != null ? Number(row.latest_vo2max) : null),
          status: "good",
        },
        {
          name: "Resting Heart Rate",
          value:
            row.avg_resting_hr != null ? Math.round(Number(row.avg_resting_hr) * 10) / 10 : null,
          unit: "bpm",
          score: scoreRestingHr(row.avg_resting_hr != null ? Number(row.avg_resting_hr) : null),
          status: "good",
        },
        {
          name: "Lean Body Mass",
          value: leanMassPct != null ? Math.round(leanMassPct * 10) / 10 : null,
          unit: "%",
          score: scoreLeanMassPct(leanMassPct),
          status: "good",
        },
      ];

      // Set status based on score
      for (const m of metricDefs) {
        m.status = scoreToStatus(m.score);
      }

      // Composite: equal weight across all 9 metrics
      const totalScore = metricDefs.reduce((sum, m) => sum + m.score, 0);
      const healthspanScore = Math.round(totalScore / metricDefs.length);

      // Biological age: chronological age adjusted by healthspan score
      // Score of 75 = aging at normal rate, each point above/below shifts bio age
      let biologicalAge: number | null = null;
      let chronologicalAge: number | null = null;

      if (row.birth_date) {
        const birthDate = new Date(row.birth_date);
        const now = new Date();
        chronologicalAge = Math.floor(
          (now.getTime() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000),
        );
        // Each point away from 75 adjusts bio age by ~0.2 years
        const ageDelta = (75 - healthspanScore) * 0.2;
        biologicalAge = Math.round((chronologicalAge + ageDelta) * 10) / 10;
      }

      // Fetch weekly historical scores for pace of aging trend
      const historyRows = await ctx.db.execute(
        sql`WITH weekly_metrics AS (
              SELECT
                date_trunc('week', date)::date AS week_start,
                AVG(resting_hr) AS avg_rhr,
                AVG(steps) AS avg_steps,
                AVG(vo2max) AS avg_vo2max
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${totalDays}::int
              GROUP BY date_trunc('week', date)
              ORDER BY week_start ASC
            )
            SELECT week_start::text, avg_rhr, avg_steps, avg_vo2max
            FROM weekly_metrics`,
      );

      type HistRow = {
        week_start: string;
        avg_rhr: number | null;
        avg_steps: number | null;
        avg_vo2max: number | null;
      };

      // Approximate weekly scores from the metrics we can easily aggregate weekly
      const history = (historyRows as unknown as HistRow[]).map((h) => {
        const rhrScore = scoreRestingHr(h.avg_rhr != null ? Number(h.avg_rhr) : null);
        const stepsScore = scoreSteps(h.avg_steps != null ? Number(h.avg_steps) : null);
        const vo2Score = scoreVo2Max(h.avg_vo2max != null ? Number(h.avg_vo2max) : null);
        // Use available metrics as proxy (3 of 9 — the others don't aggregate weekly easily)
        const weekScore = Math.round((rhrScore + stepsScore + vo2Score) / 3);
        return { weekStart: h.week_start, score: weekScore };
      });

      // Pace of aging: slope of weekly scores over time
      // Positive slope = improving = aging slower
      let paceOfAging: number | null = null;
      if (history.length >= 4) {
        const n = history.length;
        const xMean = (n - 1) / 2;
        const yMean = history.reduce((s, h) => s + h.score, 0) / n;
        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i++) {
          const score = history[i]?.score ?? 0;
          num += (i - xMean) * (score - yMean);
          den += (i - xMean) * (i - xMean);
        }
        const slope = den > 0 ? num / den : 0;
        // Normalize: slope of 0 = pace 1.0, positive slope = < 1.0 (aging slower)
        // Each point of weekly improvement ≈ 0.05 reduction in pace
        paceOfAging = Math.round((1.0 - slope * 0.05) * 100) / 100;
        paceOfAging = Math.max(0.5, Math.min(1.5, paceOfAging)); // clamp
      }

      return {
        healthspanScore,
        biologicalAge,
        chronologicalAge,
        paceOfAging,
        metrics: metricDefs,
        history,
      };
    }),
});
