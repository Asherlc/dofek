import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowEnd, dateWindowInput, dateWindowStart } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const dailyMetricsViewRowSchema = z.object({
  date: dateStringSchema,
  user_id: z.string(),
  resting_hr: z.number().nullable(),
  hrv: z.number().nullable(),
  vo2max: z.number().nullable(),
  spo2_avg: z.number().nullable(),
  respiratory_rate_avg: z.number().nullable(),
  skin_temp_c: z.number().nullable(),
  steps: z.number().nullable(),
  active_energy_kcal: z.number().nullable(),
  basal_energy_kcal: z.number().nullable(),
  distance_km: z.number().nullable(),
  flights_climbed: z.number().nullable(),
  exercise_minutes: z.number().nullable(),
  stand_hours: z.number().nullable(),
  walking_speed: z.number().nullable(),
  source_providers: z.array(z.string()),
});

export interface HrvBaselineRow {
  date: string;
  hrv: number | null;
  resting_hr: number | null;
  mean_60d: number | null;
  sd_60d: number | null;
  mean_7d: number | null;
}

export const dailyMetricsRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      return executeWithSchema(
        ctx.db,
        dailyMetricsViewRowSchema,
        sql`SELECT * FROM fitness.v_daily_metrics
            WHERE user_id = ${ctx.userId}
              AND date > ${dateWindowStart(input.endDate, input.days)}
            ORDER BY date ASC`,
      );
    }),

  latest: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const rows = await executeWithSchema(
      ctx.db,
      dailyMetricsViewRowSchema,
      sql`SELECT * FROM fitness.v_daily_metrics WHERE user_id = ${ctx.userId} ORDER BY date DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }),

  hrvBaseline: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      const hrvBaselineRowSchema = z.object({
        date: dateStringSchema,
        hrv: z.coerce.number().nullable(),
        resting_hr: z.coerce.number().nullable(),
        mean_60d: z.coerce.number().nullable(),
        sd_60d: z.coerce.number().nullable(),
        mean_7d: z.coerce.number().nullable(),
      });
      const warmupDays = input.days + 60;
      const rows = await executeWithSchema(
        ctx.db,
        hrvBaselineRowSchema,
        sql`SELECT date, hrv, resting_hr,
              AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS mean_60d,
              STDDEV(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS sd_60d,
              AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS mean_7d
            FROM fitness.v_daily_metrics
            WHERE user_id = ${ctx.userId}
              AND date > ${dateWindowStart(input.endDate, warmupDays)}
            ORDER BY date ASC`,
      );
      // Filter to only return the requested date range (discard warmup rows)
      const cutoffDate = new Date(`${input.endDate}T00:00:00`);
      cutoffDate.setDate(cutoffDate.getDate() - input.days);
      const cutoffStr = cutoffDate.toISOString().slice(0, 10);
      return rows.filter((r) => r.date >= cutoffStr);
    }),

  trends: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      const trendsRowSchema = z.object({
        avg_resting_hr: z.coerce.number().nullable(),
        avg_hrv: z.coerce.number().nullable(),
        avg_spo2: z.coerce.number().nullable(),
        avg_steps: z.coerce.number().nullable(),
        avg_active_energy: z.coerce.number().nullable(),
        avg_skin_temp: z.coerce.number().nullable(),
        stddev_resting_hr: z.coerce.number().nullable(),
        stddev_hrv: z.coerce.number().nullable(),
        stddev_spo2: z.coerce.number().nullable(),
        stddev_skin_temp: z.coerce.number().nullable(),
        latest_resting_hr: z.coerce.number().nullable(),
        latest_hrv: z.coerce.number().nullable(),
        latest_spo2: z.coerce.number().nullable(),
        latest_steps: z.coerce.number().nullable(),
        latest_active_energy: z.coerce.number().nullable(),
        latest_skin_temp: z.coerce.number().nullable(),
        latest_date: dateStringSchema.nullable(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        trendsRowSchema,
        sql`WITH current AS (
              SELECT * FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > ${dateWindowStart(input.endDate, input.days)}
            ),
            stats AS (
              SELECT
                AVG(resting_hr) AS avg_resting_hr,
                AVG(hrv) AS avg_hrv,
                AVG(spo2_avg) AS avg_spo2,
                AVG(steps) AS avg_steps,
                AVG(active_energy_kcal) AS avg_active_energy,
                AVG(skin_temp_c) AS avg_skin_temp,
                STDDEV(resting_hr) AS stddev_resting_hr,
                STDDEV(hrv) AS stddev_hrv,
                STDDEV(spo2_avg) AS stddev_spo2,
                STDDEV(skin_temp_c) AS stddev_skin_temp
              FROM current
            ),
            today AS (
              SELECT resting_hr, hrv, spo2_avg, steps, active_energy_kcal, skin_temp_c, date
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date = ${dateWindowEnd(input.endDate)}
            )
            SELECT
              stats.*,
              today.resting_hr AS latest_resting_hr,
              today.hrv AS latest_hrv,
              today.spo2_avg AS latest_spo2,
              today.steps AS latest_steps,
              today.active_energy_kcal AS latest_active_energy,
              today.skin_temp_c AS latest_skin_temp,
              today.date AS latest_date
            FROM stats LEFT JOIN today ON true`,
      );
      return rows[0] ?? null;
    }),
});
