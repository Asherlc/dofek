import { DURATION_LABELS, linearRegression } from "@dofek/training/power-analysis";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const hrCurveRowSchema = z.object({
  duration_seconds: z.coerce.number(),
  best_hr: z.coerce.number(),
  activity_date: dateStringSchema,
});

const paceCurveRowSchema = z.object({
  duration_seconds: z.coerce.number(),
  best_pace: z.coerce.number(),
  activity_date: dateStringSchema,
});

export interface CriticalHeartRateModel {
  thresholdHr: number;
  r2: number;
}

/**
 * Fit a Critical Heart Rate model from HR duration curve data.
 *
 * Model: HR(t) = thresholdHr + reserve / t
 * Analogous to Critical Power: longer durations converge on threshold HR.
 * Linearized: HR * t = thresholdHr * t + reserve
 * Linear regression of (HR*t) vs t gives slope = thresholdHr.
 *
 * Only uses durations >= 120s where the aerobic system dominates.
 */
export function fitCriticalHeartRate(
  points: { durationSeconds: number; bestHeartRate: number }[],
): CriticalHeartRateModel | null {
  const valid = points.filter((p) => p.durationSeconds >= 120 && p.bestHeartRate > 0);
  if (valid.length < 3) return null;

  const xs = valid.map((p) => p.durationSeconds);
  const ys = valid.map((p) => p.bestHeartRate * p.durationSeconds);

  const { slope: thresholdHr, r2 } = linearRegression(xs, ys);

  if (thresholdHr <= 0) return null;

  return {
    thresholdHr: Math.round(thresholdHr),
    r2: Math.round(r2 * 1000) / 1000,
  };
}

const daysInput = z.object({ days: z.number().default(90) });

export const durationCurvesRouter = router({
  /**
   * Heart Rate Duration Curve: best sustained HR for standard durations.
   * Uses cumulative sums over metric_stream heart_rate, same approach as power curves.
   */
  hrCurve: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        hrCurveRowSchema,
        sql`
        WITH activity_hr AS (
          SELECT ms.activity_id, ms.recorded_at, ms.heart_rate,
                 (a.started_at AT TIME ZONE ${ctx.timezone})::date AS activity_date,
                 ROW_NUMBER() OVER (
                   PARTITION BY ms.activity_id ORDER BY ms.recorded_at
                 ) AS rn,
                 SUM(ms.heart_rate) OVER (
                   PARTITION BY ms.activity_id ORDER BY ms.recorded_at
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 ) AS cumsum
          FROM fitness.metric_stream ms
          JOIN fitness.v_activity a ON a.id = ms.activity_id
          WHERE a.user_id = ${ctx.userId}
            AND ms.heart_rate IS NOT NULL
            AND ms.heart_rate > 0
            AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            AND ms.recorded_at > NOW() - (${input.days} + 1)::int * INTERVAL '1 day'
            AND ${enduranceTypeFilter("a")}
        ),
        sample_rate AS (
          SELECT activity_id,
                 GREATEST(ROUND(
                   EXTRACT(EPOCH FROM MAX(recorded_at) - MIN(recorded_at))::numeric
                   / NULLIF(COUNT(*) - 1, 0)
                 )::int, 1) AS interval_s
          FROM activity_hr
          GROUP BY activity_id
          HAVING COUNT(*) > 1
        ),
        durations AS (
          SELECT unnest(ARRAY[5,15,30,60,120,300,600,1200,1800,3600,5400,7200]) AS duration_s
        ),
        best_per_duration AS (
          SELECT
            d.duration_s AS duration_seconds,
            MAX(
              (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / ROUND(d.duration_s::numeric / sr.interval_s)
            )::int AS best_hr,
            (ARRAY_AGG(
              ap.activity_date::text ORDER BY
              (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / ROUND(d.duration_s::numeric / sr.interval_s) DESC
            ))[1] AS activity_date
          FROM durations d
          CROSS JOIN activity_hr ap
          JOIN sample_rate sr ON sr.activity_id = ap.activity_id
          LEFT JOIN activity_hr prev
            ON prev.activity_id = ap.activity_id
            AND prev.rn = ap.rn - ROUND(d.duration_s::numeric / sr.interval_s)::int
          WHERE ap.rn >= ROUND(d.duration_s::numeric / sr.interval_s)::int
          GROUP BY d.duration_s
        )
        SELECT duration_seconds, best_hr, activity_date
        FROM best_per_duration
        WHERE best_hr > 0
        ORDER BY duration_seconds
      `,
      );

      const results = rows.map((r) => ({
        durationSeconds: Number(r.duration_seconds),
        label: DURATION_LABELS[Number(r.duration_seconds)] ?? `${r.duration_seconds}s`,
        bestHeartRate: Number(r.best_hr),
        activityDate: String(r.activity_date),
      }));

      return {
        points: results,
        model: fitCriticalHeartRate(results),
      };
    }),

  /**
   * Pace Duration Curve: best sustained pace for standard durations.
   * Uses speed (m/s) from metric_stream, converts to pace (s/km) for output.
   * Higher speed = better pace (lower s/km), so we want MAX average speed.
   */
  paceCurve: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        paceCurveRowSchema,
        sql`
        WITH activity_speed AS (
          SELECT ms.activity_id, ms.recorded_at, ms.speed,
                 (a.started_at AT TIME ZONE ${ctx.timezone})::date AS activity_date,
                 ROW_NUMBER() OVER (
                   PARTITION BY ms.activity_id ORDER BY ms.recorded_at
                 ) AS rn,
                 SUM(ms.speed) OVER (
                   PARTITION BY ms.activity_id ORDER BY ms.recorded_at
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 ) AS cumsum
          FROM fitness.metric_stream ms
          JOIN fitness.v_activity a ON a.id = ms.activity_id
          WHERE a.user_id = ${ctx.userId}
            AND ms.speed IS NOT NULL
            AND ms.speed > 0
            AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            AND ms.recorded_at > NOW() - (${input.days} + 1)::int * INTERVAL '1 day'
            AND ${enduranceTypeFilter("a")}
        ),
        sample_rate AS (
          SELECT activity_id,
                 GREATEST(ROUND(
                   EXTRACT(EPOCH FROM MAX(recorded_at) - MIN(recorded_at))::numeric
                   / NULLIF(COUNT(*) - 1, 0)
                 )::int, 1) AS interval_s
          FROM activity_speed
          GROUP BY activity_id
          HAVING COUNT(*) > 1
        ),
        durations AS (
          SELECT unnest(ARRAY[5,15,30,60,120,300,600,1200,1800,3600,5400,7200]) AS duration_s
        ),
        best_per_duration AS (
          SELECT
            d.duration_s AS duration_seconds,
            MAX(
              (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / ROUND(d.duration_s::numeric / sr.interval_s)
            ) AS best_speed_ms,
            (ARRAY_AGG(
              ap.activity_date::text ORDER BY
              (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / ROUND(d.duration_s::numeric / sr.interval_s) DESC
            ))[1] AS activity_date
          FROM durations d
          CROSS JOIN activity_speed ap
          JOIN sample_rate sr ON sr.activity_id = ap.activity_id
          LEFT JOIN activity_speed prev
            ON prev.activity_id = ap.activity_id
            AND prev.rn = ap.rn - ROUND(d.duration_s::numeric / sr.interval_s)::int
          WHERE ap.rn >= ROUND(d.duration_s::numeric / sr.interval_s)::int
          GROUP BY d.duration_s
        )
        SELECT
          duration_seconds,
          ROUND((1000.0 / NULLIF(best_speed_ms, 0))::numeric, 1) AS best_pace,
          activity_date
        FROM best_per_duration
        WHERE best_speed_ms > 0
        ORDER BY duration_seconds
      `,
      );

      const results = rows.map((r) => ({
        durationSeconds: Number(r.duration_seconds),
        label: DURATION_LABELS[Number(r.duration_seconds)] ?? `${r.duration_seconds}s`,
        bestPaceSecondsPerKm: Number(r.best_pace),
        activityDate: String(r.activity_date),
      }));

      return { points: results };
    }),
});
