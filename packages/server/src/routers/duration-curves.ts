import { sql } from "drizzle-orm";
import { z } from "zod";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

/** Human-readable labels for each duration. */
const DURATION_LABELS: Record<number, string> = {
  5: "5s",
  15: "15s",
  30: "30s",
  60: "1min",
  120: "2min",
  300: "5min",
  600: "10min",
  1200: "20min",
  1800: "30min",
  3600: "60min",
  5400: "90min",
  7200: "120min",
};

interface HrCurveRow {
  duration_seconds: number;
  best_hr: number;
  activity_date: string;
}

interface PaceCurveRow {
  duration_seconds: number;
  best_pace: number;
  activity_date: string;
}

/** Simple linear regression: y = slope * x + intercept */
function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * (ys[i] ?? 0), 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: 0, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  const ssTotal = ys.reduce((a, y) => a + (y - yMean) ** 2, 0);
  const ssResidual = ys.reduce((a, y, i) => a + (y - (slope * (xs[i] ?? 0) + intercept)) ** 2, 0);
  const r2 = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;

  return { slope, intercept, r2 };
}

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
      const rows = await ctx.db.execute(sql`
        WITH activity_hr AS (
          SELECT ms.activity_id, ms.recorded_at, ms.heart_rate,
                 a.started_at::date AS activity_date,
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
        durations AS (
          SELECT unnest(ARRAY[5,15,30,60,120,300,600,1200,1800,3600,5400,7200]) AS duration_s
        ),
        best_per_duration AS (
          SELECT
            d.duration_s AS duration_seconds,
            MAX(
              (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / d.duration_s
            )::int AS best_hr,
            (ARRAY_AGG(
              ap.activity_date::text ORDER BY
              (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / d.duration_s DESC
            ))[1] AS activity_date
          FROM durations d
          CROSS JOIN activity_hr ap
          LEFT JOIN activity_hr prev
            ON prev.activity_id = ap.activity_id
            AND prev.rn = ap.rn - d.duration_s
          WHERE ap.rn >= d.duration_s
          GROUP BY d.duration_s
        )
        SELECT duration_seconds, best_hr, activity_date
        FROM best_per_duration
        WHERE best_hr > 0
        ORDER BY duration_seconds
      `);

      const results = (rows as unknown as HrCurveRow[]).map((r) => ({
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
      const rows = await ctx.db.execute(sql`
        WITH activity_speed AS (
          SELECT ms.activity_id, ms.recorded_at, ms.speed,
                 a.started_at::date AS activity_date,
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
            AND a.activity_type IN ('running', 'swimming')
        ),
        durations AS (
          SELECT unnest(ARRAY[5,15,30,60,120,300,600,1200,1800,3600,5400,7200]) AS duration_s
        ),
        best_per_duration AS (
          SELECT
            d.duration_s AS duration_seconds,
            MAX(
              (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / d.duration_s
            ) AS best_speed_ms,
            (ARRAY_AGG(
              ap.activity_date::text ORDER BY
              (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / d.duration_s DESC
            ))[1] AS activity_date
          FROM durations d
          CROSS JOIN activity_speed ap
          LEFT JOIN activity_speed prev
            ON prev.activity_id = ap.activity_id
            AND prev.rn = ap.rn - d.duration_s
          WHERE ap.rn >= d.duration_s
          GROUP BY d.duration_s
        )
        SELECT
          duration_seconds,
          ROUND((1000.0 / NULLIF(best_speed_ms, 0))::numeric, 1) AS best_pace,
          activity_date
        FROM best_per_duration
        WHERE best_speed_ms > 0
        ORDER BY duration_seconds
      `);

      const results = (rows as unknown as PaceCurveRow[]).map((r) => ({
        durationSeconds: Number(r.duration_seconds),
        label: DURATION_LABELS[Number(r.duration_seconds)] ?? `${r.duration_seconds}s`,
        bestPaceSecondsPerKm: Number(r.best_pace),
        activityDate: String(r.activity_date),
      }));

      return { points: results };
    }),
});
