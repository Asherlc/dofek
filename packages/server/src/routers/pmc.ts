import {
  type ActivityRow,
  buildTssModel,
  computeHrTss,
  computePowerTss,
  computeTrimp,
  estimateFtp,
  type PmcChartResult,
  type PmcDataPoint,
  type TssModelInfo,
} from "@dofek/training/pmc";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

// Re-export domain types and functions for backward compatibility with existing tests
export {
  type ActivityRow,
  type PmcChartResult,
  type PmcDataPoint,
  type TssModelInfo,
  buildTssModel,
  computeHrTss,
  computePowerTss,
  computeTrimp,
  estimateFtp,
};

export const pmcRouter = router({
  /**
   * Performance Management Chart data.
   * Reads from activity_summary rollup + user_profile for max_hr.
   * Computes daily TSS using a learned regression model (power+HR paired activities)
   * when available, falling back to generic Bannister TRIMP normalization.
   * Derives CTL (42d), ATL (7d), TSB from daily TSS.
   */
  chart: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<PmcChartResult> => {
      // Load personalized algorithm parameters
      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const effective = getEffectiveParams(storedParams);
      const { chronicTrainingLoadDays, acuteTrainingLoadDays } = effective.exponentialMovingAverage;
      const { genderFactor, exponent } = effective.trainingImpulseConstants;

      // Fetch enough history for EWMA convergence, regardless of display range.
      // A 42-day EWMA needs ~126 days to reach 95% convergence, so we always
      // fetch at least 365 days of activity data, then trim the output to the
      // requested display window.
      const minHistoryDays = 365;
      const queryDays = Math.max(input.days, minHistoryDays) + chronicTrainingLoadDays;

      // Get max HR, resting HR from user_profile + per-activity stats from activity_summary
      const combinedActivityRowSchema = z.object({
        global_max_hr: z.coerce.number().nullable(),
        resting_hr: z.coerce.number(),
        id: z.string(),
        date: dateStringSchema,
        duration_min: z.coerce.number(),
        avg_hr: z.coerce.number(),
        max_hr: z.coerce.number(),
        avg_power: z.coerce.number().nullable(),
        power_samples: z.coerce.number(),
        hr_samples: z.coerce.number(),
      });
      const activityRows = await executeWithSchema(
        ctx.db,
        combinedActivityRowSchema,
        sql`SELECT
              up.max_hr AS global_max_hr,
              COALESCE(up.resting_hr, (
                SELECT resting_hr FROM fitness.v_daily_metrics
                WHERE user_id = ${ctx.userId} AND resting_hr IS NOT NULL ORDER BY date DESC LIMIT 1
              ), 60) AS resting_hr,
              asum.activity_id AS id,
              asum.started_at::date AS date,
              EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60 AS duration_min,
              asum.avg_hr,
              asum.max_hr,
              asum.avg_power,
              asum.power_sample_count AS power_samples,
              asum.hr_sample_count AS hr_samples
            FROM fitness.activity_summary asum
            JOIN fitness.user_profile up ON up.id = asum.user_id
            WHERE up.id = ${ctx.userId}
              AND up.max_hr IS NOT NULL
              AND asum.started_at > NOW() - ${queryDays}::int * INTERVAL '1 day'
              AND asum.ended_at IS NOT NULL
              AND asum.hr_sample_count > 0`,
      );

      const allRows = activityRows;

      const globalMaxHr = allRows.length > 0 ? Number(allRows[0]?.global_max_hr) : null;
      if (!globalMaxHr) {
        return {
          data: [],
          model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
        };
      }

      const restingHr = allRows.length > 0 ? Number(allRows[0]?.resting_hr) : 60;
      const activities = allRows;

      // Compute Normalized Power per activity from metric_stream
      // NP = 4th root of mean of 4th powers of 30-second rolling average power
      const npRowSchema = z.object({
        activity_id: z.string(),
        np: z.coerce.number(),
      });
      const npRows = await executeWithSchema(
        ctx.db,
        npRowSchema,
        sql`WITH rolling AS (
              SELECT
                ms.activity_id,
                AVG(ms.power) OVER (
                  PARTITION BY ms.activity_id
                  ORDER BY ms.recorded_at
                  RANGE BETWEEN INTERVAL '29 seconds' PRECEDING AND CURRENT ROW
                ) AS rolling_30s_power
              FROM fitness.metric_stream ms
              JOIN fitness.v_activity a ON a.id = ms.activity_id
              WHERE a.user_id = ${ctx.userId}
                AND a.started_at > NOW() - ${queryDays}::int * INTERVAL '1 day'
                AND ms.power > 0
            )
            SELECT
              r.activity_id,
              ROUND(POWER(AVG(POWER(r.rolling_30s_power, 4)), 0.25)::numeric, 1) AS np
            FROM rolling r
            GROUP BY r.activity_id
            HAVING COUNT(*) >= 60`,
      );
      const npByActivity = new Map(npRows.map((r) => [r.activity_id, Number(r.np)]));

      // Estimate FTP from avg_power (not NP, which inflates for intervals)
      const ftp = estimateFtp(activities);

      // Build regression model from activities with both power and HR
      let tssModel: { slope: number; intercept: number; r2: number } | null = null;
      const pairedData: { trimp: number; powerTss: number }[] = [];

      if (ftp != null) {
        for (const act of activities) {
          const durationMin = Number(act.duration_min);
          const avgHr = Number(act.avg_hr);
          const np = npByActivity.get(act.id);

          // Require NP (computed from metric_stream) for power TSS
          if (np != null && np > 0) {
            const trimp = computeTrimp(
              durationMin,
              avgHr,
              globalMaxHr,
              restingHr,
              genderFactor,
              exponent,
            );
            const powerTss = computePowerTss(np, ftp, durationMin);
            if (trimp > 0 && powerTss > 0) {
              pairedData.push({ trimp, powerTss });
            }
          }
        }
        tssModel = buildTssModel(pairedData);
      }

      // Compute TSS per activity, then aggregate by day
      const dailyLoad = new Map<string, number>();
      for (const act of activities) {
        const durationMin = Number(act.duration_min);
        const avgHr = Number(act.avg_hr);
        const np = npByActivity.get(act.id);

        let tss: number;

        if (ftp != null && np != null && np > 0) {
          // Activity has NP from metric_stream — use standard power TSS
          tss = computePowerTss(np, ftp, durationMin);
        } else if (tssModel != null) {
          // Activity has only HR — use learned model to predict TSS from TRIMP
          const trimp = computeTrimp(
            durationMin,
            avgHr,
            globalMaxHr,
            restingHr,
            genderFactor,
            exponent,
          );
          tss = Math.max(0, tssModel.slope * trimp + tssModel.intercept);
        } else {
          // Fallback: Bannister hrTSS with personalized constants
          tss = computeHrTss(durationMin, avgHr, globalMaxHr, restingHr, genderFactor, exponent);
        }

        const dateStr = String(act.date);
        dailyLoad.set(dateStr, (dailyLoad.get(dateStr) ?? 0) + tss);
      }

      // Build date range
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - queryDays);
      const endDate = new Date();

      const result: PmcDataPoint[] = [];
      let ctl = 0;
      let atl = 0;

      const current = new Date(startDate);
      const warmUpDays = queryDays - input.days; // skip warm-up from final output
      let dayIndex = 0;

      while (current <= endDate) {
        const dateStr = current.toISOString().split("T")[0] ?? "";
        const load = dailyLoad.get(dateStr) ?? 0;

        // EWMA update with personalized windows
        ctl = ctl + (load - ctl) / chronicTrainingLoadDays;
        atl = atl + (load - atl) / acuteTrainingLoadDays;
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

      // Trim leading days before any fitness has accumulated — avoids sending
      // thousands of flat zeros when the user selects "All" but only has
      // recent data. Preserves rest days where CTL is decaying (still > 0).
      let firstMeaningfulIndex = result.findIndex((d) => d.ctl >= 0.1);
      if (firstMeaningfulIndex < 0) firstMeaningfulIndex = 0;
      const trimmedResult = result.slice(firstMeaningfulIndex);

      const modelInfo: TssModelInfo =
        tssModel != null
          ? {
              type: "learned",
              pairedActivities: pairedData.length,
              r2: Math.round(tssModel.r2 * 1000) / 1000,
              ftp,
            }
          : {
              type: "generic",
              pairedActivities: pairedData.length,
              r2: null,
              ftp,
            };

      return { data: trimmedResult, model: modelInfo };
    }),
});
