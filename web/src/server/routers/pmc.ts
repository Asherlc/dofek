import { sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.ts";

interface ActivityHrRow {
  id: string;
  date: string;
  duration_min: number;
  avg_hr: number;
  max_hr: number;
}

interface RestingHrRow {
  resting_hr: number | null;
}

export interface PmcDataPoint {
  date: string;
  load: number;
  ctl: number;
  atl: number;
  tsb: number;
}

/**
 * Compute Bannister TRIMP for an activity.
 *
 * TRIMP = duration_minutes * deltaHR_ratio * 0.64 * e^(1.92 * deltaHR_ratio)
 *   where deltaHR_ratio = (avg_hr - resting_hr) / (max_hr - resting_hr)
 *
 * Then normalize to hrTSS:
 *   hrTSS = TRIMP * (1 / TRIMP_for_1hr_at_threshold) * 100
 *   threshold HR = 85% of max HR
 */
function computeHrTss(
  durationMin: number,
  avgHr: number,
  maxHr: number,
  restingHr: number,
): number {
  if (maxHr <= restingHr || durationMin <= 0) return 0;

  const deltaHrRatio = (avgHr - restingHr) / (maxHr - restingHr);
  if (deltaHrRatio <= 0) return 0;

  // Bannister TRIMP (male coefficients)
  const trimp = durationMin * deltaHrRatio * 0.64 * Math.exp(1.92 * deltaHrRatio);

  // Threshold HR at 85% of max HR
  const thresholdHr = restingHr + 0.85 * (maxHr - restingHr);
  const thresholdDeltaRatio = (thresholdHr - restingHr) / (maxHr - restingHr); // = 0.85
  const trimpOneHourAtThreshold =
    60 * thresholdDeltaRatio * 0.64 * Math.exp(1.92 * thresholdDeltaRatio);

  if (trimpOneHourAtThreshold === 0) return 0;

  return (trimp / trimpOneHourAtThreshold) * 100;
}

export const pmcRouter = router({
  /**
   * Performance Management Chart data.
   * Computes daily hrTSS, then derives CTL (42d), ATL (7d), TSB.
   */
  chart: publicProcedure
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }) => {
      // Get max observed HR across all activities
      const maxHrResult = await ctx.db.execute(
        sql`SELECT MAX(heart_rate) AS max_hr
            FROM fitness.metric_stream
            WHERE heart_rate IS NOT NULL
              AND activity_id IS NOT NULL`,
      );
      const globalMaxHr = (maxHrResult as Record<string, unknown>[])[0]?.max_hr as number | null;
      if (!globalMaxHr) return [];

      // Get latest resting HR from daily metrics
      const restingHrResult = await ctx.db.execute(
        sql`SELECT resting_hr
            FROM fitness.v_daily_metrics
            WHERE resting_hr IS NOT NULL
            ORDER BY date DESC
            LIMIT 1`,
      );
      const restingHr = (restingHrResult as unknown as RestingHrRow[])[0]?.resting_hr ?? 60;

      // Fetch extra history for EWMA warm-up (42 days for CTL)
      const queryDays = input.days + 42;

      // Get per-activity HR stats
      const activityRows = await ctx.db.execute(
        sql`SELECT
              a.id,
              a.started_at::date AS date,
              EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60 AS duration_min,
              AVG(ms.heart_rate) AS avg_hr,
              MAX(ms.heart_rate) AS max_hr
            FROM fitness.v_activity a
            JOIN fitness.metric_stream ms ON ms.activity_id = a.id
            WHERE a.started_at > NOW() - ${queryDays}::int * INTERVAL '1 day'
              AND a.ended_at IS NOT NULL
              AND ms.heart_rate IS NOT NULL
            GROUP BY a.id, a.started_at, a.ended_at`,
      );
      const activities = activityRows as unknown as ActivityHrRow[];

      // Compute hrTSS per activity, then aggregate by day
      const dailyLoad = new Map<string, number>();
      for (const act of activities) {
        const hrTss = computeHrTss(
          Number(act.duration_min),
          Number(act.avg_hr),
          globalMaxHr,
          restingHr,
        );
        const dateStr = String(act.date);
        dailyLoad.set(dateStr, (dailyLoad.get(dateStr) ?? 0) + hrTss);
      }

      // Build date range
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - queryDays);
      const endDate = new Date();

      const result: PmcDataPoint[] = [];
      let ctl = 0;
      let atl = 0;

      const current = new Date(startDate);
      const warmUpDays = 42; // skip these from final output
      let dayIndex = 0;

      while (current <= endDate) {
        const dateStr = current.toISOString().split("T")[0];
        const load = dailyLoad.get(dateStr) ?? 0;

        // EWMA update
        ctl = ctl + (load - ctl) / 42;
        atl = atl + (load - atl) / 7;
        const tsb = ctl - atl;

        if (dayIndex >= warmUpDays) {
          result.push({
            date: dateStr,
            load: Math.round(load * 10) / 10,
            ctl: Math.round(ctl * 10) / 10,
            atl: Math.round(atl * 10) / 10,
            tsb: Math.round(tsb * 10) / 10,
          });
        }

        dayIndex++;
        current.setDate(current.getDate() + 1);
      }

      return result;
    }),
});
