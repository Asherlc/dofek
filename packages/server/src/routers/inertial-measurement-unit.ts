import { sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

export const inertialMeasurementUnitRouter = router({
  /** Daily sample counts for the last N days — powers the coverage chart */
  getDailyCounts: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(90) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute<{
        date: string;
        sample_count: number;
        hours_covered: number;
      }>(
        sql`SELECT
            date_trunc('day', recorded_at)::date::text AS date,
            count(*)::int AS sample_count,
            (count(*)::float / (50.0 * 3600))::numeric(6,2)::float AS hours_covered
          FROM fitness.inertial_measurement_unit_sample
          WHERE user_id = ${ctx.userId}::uuid
            AND recorded_at > now() - make_interval(days => ${input.days})
          GROUP BY 1
          ORDER BY 1 DESC`,
      );
      return [...rows];
    }),

  /** Sync status: latest sync time, total samples, device breakdown */
  getSyncStatus: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.execute<{
      device_id: string;
      device_type: string;
      sample_count: number;
      latest_sample: string | null;
      earliest_sample: string | null;
    }>(
      sql`SELECT
          device_id,
          device_type,
          count(*)::int AS sample_count,
          max(recorded_at)::text AS latest_sample,
          min(recorded_at)::text AS earliest_sample
        FROM fitness.inertial_measurement_unit_sample
        WHERE user_id = ${ctx.userId}::uuid
        GROUP BY device_id, device_type`,
    );
    return [...rows];
  }),

  /** Raw time series for a short window — for waveform visualization.
   * Limited to 10 minutes (30,000 samples at 50 Hz) to avoid huge responses. */
  getTimeSeries: protectedProcedure
    .input(
      z.object({
        startDate: z.string(),
        endDate: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Clamp to 10 minutes max
      const start = new Date(input.startDate);
      const end = new Date(input.endDate);
      const maxEnd = new Date(start.getTime() + 10 * 60 * 1000);
      const clampedEnd = end < maxEnd ? end : maxEnd;

      const rows = await ctx.db.execute<{
        recorded_at: string;
        x: number;
        y: number;
        z: number;
        gyroscope_x: number | null;
        gyroscope_y: number | null;
        gyroscope_z: number | null;
      }>(
        sql`SELECT
            recorded_at::text,
            x, y, z,
            gyroscope_x, gyroscope_y, gyroscope_z
          FROM fitness.inertial_measurement_unit_sample
          WHERE user_id = ${ctx.userId}::uuid
            AND recorded_at >= ${start.toISOString()}::timestamptz
            AND recorded_at < ${clampedEnd.toISOString()}::timestamptz
          ORDER BY recorded_at ASC`,
      );
      return [...rows];
    }),
});
