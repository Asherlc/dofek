import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface DailyTrendRow {
  date: string;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgCadence: number | null;
  avgSpeed: number | null;
  totalSamples: number;
  hrSamples: number;
  powerSamples: number;
  activityCount: number;
}

export interface WeeklyTrendRow {
  week: string;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgCadence: number | null;
  avgSpeed: number | null;
  totalSamples: number;
  hrSamples: number;
  powerSamples: number;
  activityCount: number;
}

function roundOrNull(value: unknown, decimals: number): number | null {
  if (value == null) return null;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

export const trendsRouter = router({
  /**
   * Daily activity metrics from the continuous aggregate.
   * Returns one row per day with pre-aggregated HR, power, cadence, speed stats.
   * Efficient for querying months/years of data.
   */
  daily: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }): Promise<DailyTrendRow[]> => {
      const dailyTrendRowSchema = z.object({
        date: z.string(),
        avg_hr: z.coerce.number().nullable(),
        max_hr: z.coerce.number().nullable(),
        avg_power: z.coerce.number().nullable(),
        max_power: z.coerce.number().nullable(),
        avg_cadence: z.coerce.number().nullable(),
        avg_speed: z.coerce.number().nullable(),
        total_samples: z.coerce.number(),
        hr_samples: z.coerce.number(),
        power_samples: z.coerce.number(),
        activity_count: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        dailyTrendRowSchema,
        sql`SELECT
              bucket::date::text AS date,
              avg_hr,
              max_hr,
              avg_power,
              max_power,
              avg_cadence,
              avg_speed,
              total_samples,
              hr_samples,
              power_samples,
              activity_count
            FROM fitness.cagg_metric_daily
            WHERE user_id = ${ctx.userId}
              AND bucket > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY bucket ASC`,
      );

      return rows.map((row) => ({
        date: row.date,
        avgHr: roundOrNull(row.avg_hr, 1),
        maxHr: row.max_hr != null ? Number(row.max_hr) : null,
        avgPower: roundOrNull(row.avg_power, 1),
        maxPower: row.max_power != null ? Number(row.max_power) : null,
        avgCadence: roundOrNull(row.avg_cadence, 1),
        avgSpeed: roundOrNull(row.avg_speed, 2),
        totalSamples: Number(row.total_samples),
        hrSamples: Number(row.hr_samples),
        powerSamples: Number(row.power_samples),
        activityCount: Number(row.activity_count),
      }));
    }),

  /**
   * Weekly activity metrics from the hierarchical continuous aggregate.
   * Returns one row per week with pre-aggregated stats.
   * Best for long-range views spanning months to years.
   */
  weekly: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ weeks: z.number().default(52) }))
    .query(async ({ ctx, input }): Promise<WeeklyTrendRow[]> => {
      const days = input.weeks * 7;
      const weeklyTrendRowSchema = z.object({
        week: z.string(),
        avg_hr: z.coerce.number().nullable(),
        max_hr: z.coerce.number().nullable(),
        avg_power: z.coerce.number().nullable(),
        max_power: z.coerce.number().nullable(),
        avg_cadence: z.coerce.number().nullable(),
        avg_speed: z.coerce.number().nullable(),
        total_samples: z.coerce.number(),
        hr_samples: z.coerce.number(),
        power_samples: z.coerce.number(),
        activity_count: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        weeklyTrendRowSchema,
        sql`SELECT
              bucket::date::text AS week,
              avg_hr,
              max_hr,
              avg_power,
              max_power,
              avg_cadence,
              avg_speed,
              total_samples,
              hr_samples,
              power_samples,
              activity_count
            FROM fitness.cagg_metric_weekly
            WHERE user_id = ${ctx.userId}
              AND bucket > NOW() - ${days}::int * INTERVAL '1 day'
            ORDER BY bucket ASC`,
      );

      return rows.map((row) => ({
        week: row.week,
        avgHr: roundOrNull(row.avg_hr, 1),
        maxHr: row.max_hr != null ? Number(row.max_hr) : null,
        avgPower: roundOrNull(row.avg_power, 1),
        maxPower: row.max_power != null ? Number(row.max_power) : null,
        avgCadence: roundOrNull(row.avg_cadence, 1),
        avgSpeed: roundOrNull(row.avg_speed, 2),
        totalSamples: Number(row.total_samples),
        hrSamples: Number(row.hr_samples),
        powerSamples: Number(row.power_samples),
        activityCount: Number(row.activity_count),
      }));
    }),
});
