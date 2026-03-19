import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { linearRegression } from "../lib/math.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type ActivityRow = {
  id: string;
  date: string;
  duration_min: number;
  avg_hr: number;
  max_hr: number;
  avg_power: number | null;
  power_samples: number;
  hr_samples: number;
};

export interface PmcDataPoint {
  date: string;
  load: number;
  ctl: number;
  atl: number;
  tsb: number;
}

export interface TssModelInfo {
  type: "learned" | "generic";
  pairedActivities: number;
  r2: number | null;
  ftp: number | null;
}

export interface PmcChartResult {
  data: PmcDataPoint[];
  model: TssModelInfo;
}

/**
 * Compute Bannister TRIMP for an activity.
 *
 * TRIMP = duration_minutes * deltaHR_ratio * genderFactor * e^(exponent * deltaHR_ratio)
 *   where deltaHR_ratio = (avg_hr - resting_hr) / (max_hr - resting_hr)
 *
 * genderFactor and exponent default to 0.64 and 1.92 (Bannister generic)
 * but can be personalized per user.
 */
export function computeTrimp(
  durationMin: number,
  avgHr: number,
  maxHr: number,
  restingHr: number,
  genderFactor = 0.64,
  exponent = 1.92,
): number {
  if (maxHr <= restingHr || durationMin <= 0) return 0;
  const deltaHrRatio = (avgHr - restingHr) / (maxHr - restingHr);
  if (deltaHrRatio <= 0) return 0;
  return durationMin * deltaHrRatio * genderFactor * Math.exp(exponent * deltaHrRatio);
}

/**
 * Compute hrTSS using Bannister TRIMP normalized to 1hr at threshold.
 * This is the fallback when no learned model is available.
 */
export function computeHrTss(
  durationMin: number,
  avgHr: number,
  maxHr: number,
  restingHr: number,
  genderFactor = 0.64,
  exponent = 1.92,
): number {
  const trimp = computeTrimp(durationMin, avgHr, maxHr, restingHr, genderFactor, exponent);
  if (trimp === 0) return 0;

  // Threshold HR at 85% of max HR
  const thresholdDeltaRatio = 0.85;
  const trimpOneHourAtThreshold =
    60 * thresholdDeltaRatio * genderFactor * Math.exp(exponent * thresholdDeltaRatio);

  if (trimpOneHourAtThreshold === 0) return 0;
  return (trimp / trimpOneHourAtThreshold) * 100;
}

/**
 * Compute power-based TSS.
 * TSS = (NP / FTP)^2 * duration_hours * 100
 * Uses Normalized Power (4th root of mean of 4th powers of 30s rolling avg).
 */
export function computePowerTss(normalizedPower: number, ftp: number, durationMin: number): number {
  if (ftp <= 0 || durationMin <= 0 || normalizedPower <= 0) return 0;
  const intensityFactor = normalizedPower / ftp;
  return intensityFactor ** 2 * (durationMin / 60) * 100;
}

/**
 * Build a linear regression model: powerTss = slope * trimp + intercept.
 * Returns null if insufficient data or poor fit.
 */
export function buildTssModel(
  paired: { trimp: number; powerTss: number }[],
): { slope: number; intercept: number; r2: number } | null {
  // Require at least 10 paired activities
  if (paired.length < 10) return null;

  const xs = paired.map((point) => point.trimp);
  const ys = paired.map((point) => point.powerTss);

  const result = linearRegression(xs, ys);

  // Require a reasonable fit (R² >= 0.3) and positive slope
  if (result.r2 < 0.3 || result.slope <= 0) return null;

  return result;
}

/**
 * Estimate FTP from activity data.
 * Uses highest avg_power from activities >= 20 min duration, multiplied by 0.95.
 *
 * Intentionally uses avg_power rather than Normalized Power (NP).
 * NP inflates power for interval workouts via 4th-power averaging,
 * which produces unrealistically high FTP estimates from variable efforts.
 */
export function estimateFtp(activities: ActivityRow[]): number | null {
  const qualifying = activities.filter(
    (act) => act.avg_power != null && act.avg_power > 0 && act.duration_min >= 20,
  );
  if (qualifying.length === 0) return null;
  const bestPower = Math.max(...qualifying.map((act) => Number(act.avg_power)));
  return Math.round(bestPower * 0.95);
}

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

      // Fetch extra history for EWMA warm-up
      const queryDays = input.days + chronicTrainingLoadDays;

      // Get max HR, resting HR from user_profile + per-activity stats from activity_summary
      const combinedActivityRowSchema = z.object({
        global_max_hr: z.coerce.number().nullable(),
        resting_hr: z.coerce.number(),
        id: z.string(),
        date: z.string(),
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
      const warmUpDays = chronicTrainingLoadDays; // skip warm-up from final output
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

      // Trim leading days with no cumulative load — avoids sending thousands
      // of zeros when the user selects "All" but only has recent data.
      let firstLoadIndex = result.findIndex((d) => d.load > 0);
      if (firstLoadIndex < 0) firstLoadIndex = 0;
      const trimmedResult = result.slice(firstLoadIndex);

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
