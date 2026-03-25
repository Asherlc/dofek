import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const RUNNING_TYPES = ["running", "trail_running"];

function runningTypeFilter(alias: string) {
  const list = RUNNING_TYPES.map((t) => `'${t}'`).join(", ");
  return sql.raw(`${alias}.activity_type IN (${list})`);
}

export interface RunningDynamicsRow {
  date: string;
  activityName: string;
  cadence: number;
  strideLengthMeters: number | null;
  stanceTimeMs: number | null;
  verticalOscillationMm: number | null;
  paceSecondsPerKm: number;
  distanceKm: number;
}

export interface PaceTrendRow {
  date: string;
  activityName: string;
  paceSecondsPerKm: number;
  distanceKm: number;
  durationMinutes: number;
}

const daysInput = z.object({ days: z.number().default(90) });

export const runningRouter = router({
  /**
   * Running dynamics per activity: cadence, stride length, stance time,
   * vertical oscillation, pace, and distance.
   * Reads from activity_summary rollup filtered to running activities.
   */
  dynamics: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<RunningDynamicsRow[]> => {
      const dynamicsRowSchema = z.object({
        date: dateStringSchema,
        name: z.string(),
        avg_cadence: z.coerce.number(),
        avg_stride_length: z.coerce.number().nullable(),
        avg_stance_time: z.coerce.number().nullable(),
        avg_vertical_osc: z.coerce.number().nullable(),
        avg_speed: z.coerce.number(),
        total_distance: z.coerce.number(),
      });

      const rows = await executeWithSchema(
        ctx.db,
        dynamicsRowSchema,
        sql`SELECT
              (asum.started_at AT TIME ZONE ${ctx.timezone})::date AS date,
              asum.name,
              asum.avg_cadence,
              asum.avg_stride_length,
              asum.avg_stance_time,
              asum.avg_vertical_osc,
              asum.avg_speed,
              asum.total_distance
            FROM fitness.activity_summary asum
            WHERE asum.user_id = ${ctx.userId}
              AND asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ${runningTypeFilter("asum")}
              AND asum.avg_speed > 0
              AND asum.avg_cadence > 0
            ORDER BY asum.started_at`,
      );

      return rows.map((row) => ({
        date: row.date,
        activityName: row.name,
        cadence: row.avg_cadence,
        strideLengthMeters: row.avg_stride_length,
        stanceTimeMs: row.avg_stance_time,
        verticalOscillationMm: row.avg_vertical_osc,
        paceSecondsPerKm: Math.round(1000 / row.avg_speed),
        distanceKm: Math.round((row.total_distance / 1000) * 10) / 10,
      }));
    }),

  /**
   * Pace trend per running activity: average pace, distance, duration.
   * Simple overview of how fast and far each run was.
   */
  paceTrend: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<PaceTrendRow[]> => {
      const paceTrendRowSchema = z.object({
        date: dateStringSchema,
        name: z.string(),
        avg_speed: z.coerce.number(),
        total_distance: z.coerce.number(),
        duration_seconds: z.coerce.number(),
      });

      const rows = await executeWithSchema(
        ctx.db,
        paceTrendRowSchema,
        sql`SELECT
              (asum.started_at AT TIME ZONE ${ctx.timezone})::date AS date,
              asum.name,
              asum.avg_speed,
              asum.total_distance,
              EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at))::int AS duration_seconds
            FROM fitness.activity_summary asum
            WHERE asum.user_id = ${ctx.userId}
              AND asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ${runningTypeFilter("asum")}
              AND asum.avg_speed > 0
              AND asum.ended_at IS NOT NULL
            ORDER BY asum.started_at`,
      );

      return rows.map((row) => ({
        date: row.date,
        activityName: row.name,
        paceSecondsPerKm: Math.round(1000 / row.avg_speed),
        distanceKm: Math.round((row.total_distance / 1000) * 10) / 10,
        durationMinutes: Math.round(row.duration_seconds / 60),
      }));
    }),
});
