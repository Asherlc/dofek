import {
  type CriticalPowerModel,
  computeNormalizedPower,
  computePowerCurve,
  DURATION_LABELS,
  fitCriticalPower,
} from "@dofek/training/power-analysis";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { CriticalPowerModel };

// ── Zod schemas for DB results ───────────────────────────────

const powerCurveSampleSchema = z.object({
  activity_id: z.string(),
  activity_date: dateStringSchema,
  power: z.coerce.number(),
  interval_s: z.coerce.number(),
});

const normalizedPowerSampleSchema = z.object({
  activity_id: z.string(),
  activity_date: dateStringSchema,
  activity_name: z.string().nullable(),
  power: z.coerce.number(),
  interval_s: z.coerce.number(),
});

// ── Data fetchers (simple indexed queries) ───────────────────

/**
 * Fetch per-sample power data for power curve computation.
 * Includes zero-power (coasting) samples. Returns samples ordered
 * by activity then time, with the per-activity recording interval.
 */
function powerCurveSamplesQuery(days: number, userId: string, timezone: string) {
  return sql`
    WITH activity_info AS (
      SELECT a.id AS activity_id,
             (a.started_at AT TIME ZONE ${timezone})::date::text AS activity_date,
             GREATEST(ROUND(
               EXTRACT(EPOCH FROM MAX(ms.recorded_at) - MIN(ms.recorded_at))::numeric
               / NULLIF(COUNT(*) - 1, 0)
             )::int, 1) AS interval_s
      FROM fitness.metric_stream ms
      JOIN fitness.v_activity a ON a.id = ms.activity_id
      WHERE a.user_id = ${userId}
        AND ms.power IS NOT NULL
        AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
        AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
        AND ${enduranceTypeFilter("a")}
      GROUP BY a.id, a.started_at
      HAVING COUNT(*) > 1
    )
    SELECT ms.activity_id,
           ai.activity_date,
           COALESCE(ms.power, 0) AS power,
           ai.interval_s
    FROM fitness.metric_stream ms
    JOIN activity_info ai ON ai.activity_id = ms.activity_id
    WHERE ms.power IS NOT NULL
      AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
    ORDER BY ms.activity_id, ms.recorded_at
  `;
}

/**
 * Fetch per-sample power data for Normalized Power computation.
 * Excludes zero-power samples (coasting) since they'd artificially
 * lower Normalized Power. Only includes activities with >= 240 power-positive samples
 * (~20 min at any sample rate).
 */
function normalizedPowerSamplesQuery(days: number, userId: string, timezone: string) {
  return sql`
    WITH activity_info AS (
      SELECT a.id AS activity_id,
             (a.started_at AT TIME ZONE ${timezone})::date::text AS activity_date,
             a.name AS activity_name,
             GREATEST(ROUND(
               EXTRACT(EPOCH FROM MAX(ms.recorded_at) - MIN(ms.recorded_at))::numeric
               / NULLIF(COUNT(*) - 1, 0)
             )::int, 1) AS interval_s
      FROM fitness.metric_stream ms
      JOIN fitness.v_activity a ON a.id = ms.activity_id
      WHERE a.user_id = ${userId}
        AND ms.power > 0
        AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
        AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
        AND ${enduranceTypeFilter("a")}
      GROUP BY a.id, a.started_at, a.name
      HAVING COUNT(*) >= 240
    )
    SELECT ms.activity_id,
           ai.activity_date,
           ai.activity_name,
           ms.power,
           ai.interval_s
    FROM fitness.metric_stream ms
    JOIN activity_info ai ON ai.activity_id = ms.activity_id
    WHERE ms.power > 0
      AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
    ORDER BY ms.activity_id, ms.recorded_at
  `;
}

// ── Router ───────────────────────────────────────────────────

export const powerRouter = router({
  /**
   * Power Duration Curve: best average power for standard durations.
   * Fetches raw samples then computes via prefix sums in app code.
   */
  powerCurve: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const samples = await executeWithSchema(
        ctx.db,
        powerCurveSampleSchema,
        powerCurveSamplesQuery(input.days, ctx.userId, ctx.timezone),
      );

      const results = computePowerCurve(samples);

      return {
        points: results.map((r) => ({
          durationSeconds: r.durationSeconds,
          label: DURATION_LABELS[r.durationSeconds] ?? `${r.durationSeconds}s`,
          bestPower: r.bestPower,
          activityDate: r.activityDate,
        })),
        model: fitCriticalPower(results),
      };
    }),

  /**
   * eFTP trend: estimated Functional Threshold Power over time.
   * Uses per-activity Normalized Power (NP) × 0.95.
   *
   * NP accounts for the metabolic cost of interval efforts via the
   * fourth-power of 30s rolling averages. For interval-heavy training,
   * NP is significantly higher than average power and better reflects
   * the athlete's actual sustainable output.
   */
  eftpTrend: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      const normalizedPowerSamples = await executeWithSchema(
        ctx.db,
        normalizedPowerSampleSchema,
        normalizedPowerSamplesQuery(input.days, ctx.userId, ctx.timezone),
      );

      const normalizedPowerResults = computeNormalizedPower(normalizedPowerSamples);

      const trend = normalizedPowerResults.map((r) => ({
        date: r.activityDate,
        eftp: Math.round(r.normalizedPower * 0.95),
        activityName: r.activityName,
      }));

      // Compute current eFTP via CP model from last 90 days' power curve
      const pcSamples = await executeWithSchema(
        ctx.db,
        powerCurveSampleSchema,
        powerCurveSamplesQuery(90, ctx.userId, ctx.timezone),
      );

      const pcResults = computePowerCurve(pcSamples);
      const model = fitCriticalPower(pcResults);

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
