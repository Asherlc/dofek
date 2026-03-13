import { sql } from "drizzle-orm";
import { z } from "zod";
import { DURATION_LABELS } from "../lib/duration-labels.ts";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { linearRegression } from "../lib/math.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

interface PowerCurveRow {
  duration_seconds: number;
  best_power: number;
  activity_date: string;
}

interface EftpRow {
  activity_date: string;
  activity_name: string | null;
  best_20min_power: number;
}

export interface CriticalPowerModel {
  cp: number;
  wPrime: number;
  r2: number;
}

/**
 * Fit Morton's 2-parameter Critical Power model (Monod-Scherrer).
 *
 * Model: P(t) = CP + W'/t
 * Linearized: Work = P*t = CP*t + W'
 * Linear regression of Work vs Time gives slope=CP, intercept=W'.
 *
 * Only uses durations >= 120s where the aerobic system dominates.
 */
function fitCriticalPower(
  points: { durationSeconds: number; bestPower: number }[],
): CriticalPowerModel | null {
  const valid = points.filter((p) => p.durationSeconds >= 120 && p.bestPower > 0);
  if (valid.length < 3) return null;

  const xs = valid.map((p) => p.durationSeconds);
  const ys = valid.map((p) => p.bestPower * p.durationSeconds); // work in joules

  const { slope: cp, intercept: wPrime, r2 } = linearRegression(xs, ys);

  if (cp <= 0) return null;

  return {
    cp: Math.round(cp),
    wPrime: Math.round(wPrime),
    r2: Math.round(r2 * 1000) / 1000,
  };
}

/**
 * Single query that computes best average power for all standard durations.
 *
 * Uses cumulative sums to avoid per-duration window functions:
 *   rolling_avg(i, d) = (cumsum[i] - cumsum[i - d]) / d
 *
 * Includes zero-power (coasting) samples and detects the recording interval
 * per activity so it works with both 1-second FIT data and multi-second
 * sources like Peloton (5-second intervals).
 *
 * Returns one row per duration with the best power and the activity date it came from.
 */
function powerCurveQuery(days: number, userId: string) {
  return sql`
    WITH activity_power AS (
      SELECT ms.activity_id, ms.recorded_at,
             COALESCE(ms.power, 0) AS power,
             a.started_at::date AS activity_date,
             ROW_NUMBER() OVER (
               PARTITION BY ms.activity_id ORDER BY ms.recorded_at
             ) AS rn,
             SUM(COALESCE(ms.power, 0)) OVER (
               PARTITION BY ms.activity_id ORDER BY ms.recorded_at
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS cumsum
      FROM fitness.metric_stream ms
      JOIN fitness.v_activity a ON a.id = ms.activity_id
      WHERE a.user_id = ${userId}
        AND ms.power IS NOT NULL
        AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
        AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
        AND ${enduranceTypeFilter("a")}
    ),
    sample_rate AS (
      SELECT activity_id,
             GREATEST(ROUND(
               EXTRACT(EPOCH FROM MAX(recorded_at) - MIN(recorded_at))::numeric
               / NULLIF(COUNT(*) - 1, 0)
             )::int, 1) AS interval_s
      FROM activity_power
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
          (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / d.duration_s
        )::int AS best_power,
        (ARRAY_AGG(
          ap.activity_date::text ORDER BY
          (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / d.duration_s DESC
        ))[1] AS activity_date
      FROM durations d
      CROSS JOIN activity_power ap
      JOIN sample_rate sr ON sr.activity_id = ap.activity_id
      LEFT JOIN activity_power prev
        ON prev.activity_id = ap.activity_id
        AND prev.rn = ap.rn - ROUND(d.duration_s::numeric / sr.interval_s)::int
      WHERE ap.rn >= ROUND(d.duration_s::numeric / sr.interval_s)::int
      GROUP BY d.duration_s
    )
    SELECT duration_seconds, best_power, activity_date
    FROM best_per_duration
    WHERE best_power > 0
    ORDER BY duration_seconds
  `;
}

export const powerRouter = router({
  /**
   * Power Duration Curve: best average power for standard durations.
   * Single query computes all durations via cumulative sums.
   */
  powerCurve: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(powerCurveQuery(input.days, ctx.userId));

      const results = (rows as unknown as PowerCurveRow[]).map((r) => ({
        durationSeconds: Number(r.duration_seconds),
        label: DURATION_LABELS[Number(r.duration_seconds)] ?? `${r.duration_seconds}s`,
        bestPower: Number(r.best_power),
        activityDate: String(r.activity_date),
      }));

      return {
        points: results,
        model: fitCriticalPower(results),
      };
    }),

  /**
   * eFTP trend: estimated Functional Threshold Power over time.
   * eFTP = 95% of best 20-minute power for each qualifying activity.
   */
  eftpTrend: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      // Find best 20-min (1200s) average power per activity.
      // Includes zero-power samples and detects recording interval per activity.
      const rows = await ctx.db.execute(sql`
        WITH activity_power AS (
          SELECT ms.activity_id, ms.recorded_at,
                 COALESCE(ms.power, 0) AS power,
                 a.started_at::date AS activity_date,
                 a.name AS activity_name,
                 ROW_NUMBER() OVER (
                   PARTITION BY ms.activity_id ORDER BY ms.recorded_at
                 ) AS rn,
                 SUM(COALESCE(ms.power, 0)) OVER (
                   PARTITION BY ms.activity_id ORDER BY ms.recorded_at
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 ) AS cumsum
          FROM fitness.metric_stream ms
          JOIN fitness.v_activity a ON a.id = ms.activity_id
          WHERE a.user_id = ${ctx.userId}
            AND ms.power IS NOT NULL
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
          FROM activity_power
          GROUP BY activity_id
          HAVING COUNT(*) > 1
        )
        SELECT
          ap.activity_date::text AS activity_date,
          ap.activity_name,
          MAX((ap.cumsum - prev.cumsum)::numeric / 1200)::int AS best_20min_power
        FROM activity_power ap
        JOIN sample_rate sr ON sr.activity_id = ap.activity_id
        JOIN activity_power prev
          ON prev.activity_id = ap.activity_id
          AND prev.rn = ap.rn - ROUND(1200.0 / sr.interval_s)::int
        GROUP BY ap.activity_id, ap.activity_date, ap.activity_name
        HAVING MAX((ap.cumsum - prev.cumsum)::numeric / 1200) > 0
        ORDER BY ap.activity_date
      `);

      const trend = (rows as unknown as EftpRow[]).map((r) => ({
        date: String(r.activity_date),
        eftp: Math.round(Number(r.best_20min_power) * 0.95),
        activityName: r.activity_name,
      }));

      // Compute current eFTP via CP model from last 90 days' power curve (single query)
      const cpRows = await ctx.db.execute(powerCurveQuery(90, ctx.userId));
      const cpPoints = (cpRows as unknown as PowerCurveRow[]).map((r) => ({
        durationSeconds: Number(r.duration_seconds),
        bestPower: Number(r.best_power),
      }));

      const model = fitCriticalPower(cpPoints);
      // Fall back to 95% of best recent 20-min power if CP model can't fit
      let currentEftp: number | null = model?.cp ?? null;
      if (currentEftp == null) {
        const recent = trend.filter((t) => {
          const date = new Date(t.date);
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - 90);
          return date >= cutoff;
        });
        currentEftp = recent.length > 0 ? Math.max(...recent.map((t) => t.eftp)) : null;
      }

      return { trend, currentEftp, model };
    }),
});
