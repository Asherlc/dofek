import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

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
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT * FROM fitness.v_daily_metrics
            WHERE user_id = ${ctx.userId}
              AND date > CURRENT_DATE - ${input.days}::int
            ORDER BY date ASC`,
      );
      return rows;
    }),

  latest: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const rows = await ctx.db.execute(
      sql`SELECT * FROM fitness.v_daily_metrics WHERE user_id = ${ctx.userId} ORDER BY date DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }),

  hrvBaseline: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const hrvBaselineRowSchema = z.object({
        date: z.string(),
        hrv: z.coerce.number().nullable(),
        resting_hr: z.coerce.number().nullable(),
        mean_60d: z.coerce.number().nullable(),
        sd_60d: z.coerce.number().nullable(),
        mean_7d: z.coerce.number().nullable(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        hrvBaselineRowSchema,
        sql`SELECT date, hrv, resting_hr,
              AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS mean_60d,
              STDDEV(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS sd_60d,
              AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS mean_7d
            FROM fitness.v_daily_metrics
            WHERE user_id = ${ctx.userId}
              AND date > CURRENT_DATE - ${input.days}::int - 60
            ORDER BY date ASC`,
      );
      // Filter to only return the requested date range (discard warmup rows)
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - input.days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      return rows.filter((r) => r.date >= cutoffStr);
    }),

  trends: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`WITH current AS (
              SELECT * FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${input.days}::int
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
            latest AS (
              SELECT
                date,
                FIRST_VALUE(resting_hr) OVER (ORDER BY CASE WHEN resting_hr IS NOT NULL THEN date END DESC NULLS LAST) AS latest_resting_hr,
                FIRST_VALUE(hrv) OVER (ORDER BY CASE WHEN hrv IS NOT NULL THEN date END DESC NULLS LAST) AS latest_hrv,
                FIRST_VALUE(spo2_avg) OVER (ORDER BY CASE WHEN spo2_avg IS NOT NULL THEN date END DESC NULLS LAST) AS latest_spo2,
                FIRST_VALUE(steps) OVER (ORDER BY CASE WHEN steps IS NOT NULL THEN date END DESC NULLS LAST) AS latest_steps,
                FIRST_VALUE(active_energy_kcal) OVER (ORDER BY CASE WHEN active_energy_kcal IS NOT NULL THEN date END DESC NULLS LAST) AS latest_active_energy,
                FIRST_VALUE(skin_temp_c) OVER (ORDER BY CASE WHEN skin_temp_c IS NOT NULL THEN date END DESC NULLS LAST) AS latest_skin_temp,
                ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
              FROM current
            )
            SELECT
              stats.*,
              l.latest_resting_hr,
              l.latest_hrv,
              l.latest_spo2,
              l.latest_steps,
              l.latest_active_energy,
              l.latest_skin_temp,
              l.date AS latest_date
            FROM stats, latest l
            WHERE l.rn = 1`,
      );
      return rows[0] ?? null;
    }),
});
