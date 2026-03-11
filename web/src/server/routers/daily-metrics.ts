import { sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.js";

export const dailyMetricsRouter = router({
  list: publicProcedure
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT * FROM fitness.v_daily_metrics
            WHERE date > CURRENT_DATE - ${input.days}::int
            ORDER BY date ASC`,
      );
      return rows;
    }),

  latest: publicProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.execute(
      sql`SELECT * FROM fitness.v_daily_metrics ORDER BY date DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }),

  trends: publicProcedure
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`WITH current AS (
              SELECT * FROM fitness.v_daily_metrics
              WHERE date > CURRENT_DATE - ${input.days}::int
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
            )
            SELECT
              stats.*,
              (SELECT resting_hr FROM current WHERE resting_hr IS NOT NULL ORDER BY date DESC LIMIT 1) AS latest_resting_hr,
              (SELECT hrv FROM current WHERE hrv IS NOT NULL ORDER BY date DESC LIMIT 1) AS latest_hrv,
              (SELECT spo2_avg FROM current WHERE spo2_avg IS NOT NULL ORDER BY date DESC LIMIT 1) AS latest_spo2,
              (SELECT steps FROM current WHERE steps IS NOT NULL ORDER BY date DESC LIMIT 1) AS latest_steps,
              (SELECT active_energy_kcal FROM current WHERE active_energy_kcal IS NOT NULL ORDER BY date DESC LIMIT 1) AS latest_active_energy,
              (SELECT skin_temp_c FROM current WHERE skin_temp_c IS NOT NULL ORDER BY date DESC LIMIT 1) AS latest_skin_temp,
              (SELECT date FROM current ORDER BY date DESC LIMIT 1) AS latest_date
            FROM stats`,
      );
      return rows[0] ?? null;
    }),
});
