import { sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.ts";

/** Standard durations for the power duration curve (in seconds). */
const STANDARD_DURATIONS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200] as const;

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

interface EftpRow {
  activity_date: string;
  activity_name: string | null;
  best_20min_power: number;
}

export const powerRouter = router({
  /**
   * Power Duration Curve: best average power for standard durations.
   * For each duration, finds the best rolling average power across all
   * activities in the time range.
   */
  powerCurve: publicProcedure
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const results: Array<{
        durationSeconds: number;
        label: string;
        bestPower: number;
        activityDate: string;
      }> = [];

      for (const duration of STANDARD_DURATIONS) {
        const rows = await ctx.db.execute(sql`
          WITH activity_power AS (
            SELECT ms.activity_id, ms.recorded_at, ms.power,
                   a.started_at::date AS activity_date
            FROM fitness.metric_stream ms
            JOIN fitness.v_activity a ON a.id = ms.activity_id
            WHERE ms.power > 0
              AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
          )
          SELECT
            ${duration}::int AS duration_seconds,
            MAX(avg_power)::int AS best_power,
            activity_date::text AS activity_date
          FROM (
            SELECT activity_id, activity_date,
                   AVG(power) OVER (
                     PARTITION BY activity_id ORDER BY recorded_at
                     ROWS BETWEEN ${duration - 1} PRECEDING AND CURRENT ROW
                   ) AS avg_power,
                   COUNT(*) OVER (
                     PARTITION BY activity_id ORDER BY recorded_at
                     ROWS BETWEEN ${duration - 1} PRECEDING AND CURRENT ROW
                   ) AS window_size
            FROM activity_power
          ) sub
          WHERE window_size >= ${duration}
          GROUP BY duration_seconds, activity_date
          ORDER BY best_power DESC
          LIMIT 1
        `);

        const row = rows[0] as Record<string, unknown> | undefined;
        if (row) {
          results.push({
            durationSeconds: Number(row.duration_seconds),
            label: DURATION_LABELS[duration] ?? `${duration}s`,
            bestPower: Number(row.best_power),
            activityDate: String(row.activity_date),
          });
        }
      }

      return results;
    }),

  /**
   * eFTP trend: estimated Functional Threshold Power over time.
   * eFTP = 95% of best 20-minute power for each qualifying activity.
   */
  eftpTrend: publicProcedure
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      // Find best 20-min (1200s) average power per activity
      const rows = await ctx.db.execute(sql`
        WITH activity_power AS (
          SELECT ms.activity_id, ms.recorded_at, ms.power,
                 a.started_at::date AS activity_date,
                 a.name AS activity_name
          FROM fitness.metric_stream ms
          JOIN fitness.v_activity a ON a.id = ms.activity_id
          WHERE ms.power > 0
            AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
        ),
        rolling AS (
          SELECT activity_id, activity_date, activity_name,
                 AVG(power) OVER (
                   PARTITION BY activity_id ORDER BY recorded_at
                   ROWS BETWEEN 1199 PRECEDING AND CURRENT ROW
                 ) AS avg_power,
                 COUNT(*) OVER (
                   PARTITION BY activity_id ORDER BY recorded_at
                   ROWS BETWEEN 1199 PRECEDING AND CURRENT ROW
                 ) AS window_size
          FROM activity_power
        )
        SELECT
          activity_date::text AS activity_date,
          activity_name,
          MAX(avg_power)::int AS best_20min_power
        FROM rolling
        WHERE window_size >= 1200
        GROUP BY activity_id, activity_date, activity_name
        HAVING MAX(avg_power) > 0
        ORDER BY activity_date
      `);

      const trend = (rows as unknown as EftpRow[]).map((r) => ({
        date: String(r.activity_date),
        eftp: Math.round(Number(r.best_20min_power) * 0.95),
        activityName: r.activity_name,
      }));

      // Current eFTP = best in last 90 days
      const recent = trend.filter((t) => {
        const date = new Date(t.date);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        return date >= cutoff;
      });
      const currentEftp = recent.length > 0 ? Math.max(...recent.map((t) => t.eftp)) : null;

      return { trend, currentEftp };
    }),
});
