import { sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../trpc.ts";

interface ActivityRow {
  id: string;
  date: string;
  duration_min: number;
  avg_hr: number;
  max_hr: number;
  avg_power: number | null;
  power_samples: number;
  hr_samples: number;
}

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

/** Simple linear regression: y = slope * x + intercept */
function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: 0, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  const ssTotal = ys.reduce((a, y) => a + (y - yMean) ** 2, 0);
  const ssResidual = ys.reduce((a, y, i) => a + (y - (slope * xs[i] + intercept)) ** 2, 0);
  const r2 = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;

  return { slope, intercept, r2 };
}

/**
 * Compute Bannister TRIMP for an activity.
 *
 * TRIMP = duration_minutes * deltaHR_ratio * 0.64 * e^(1.92 * deltaHR_ratio)
 *   where deltaHR_ratio = (avg_hr - resting_hr) / (max_hr - resting_hr)
 */
function computeTrimp(
  durationMin: number,
  avgHr: number,
  maxHr: number,
  restingHr: number,
): number {
  if (maxHr <= restingHr || durationMin <= 0) return 0;
  const deltaHrRatio = (avgHr - restingHr) / (maxHr - restingHr);
  if (deltaHrRatio <= 0) return 0;
  return durationMin * deltaHrRatio * 0.64 * Math.exp(1.92 * deltaHrRatio);
}

/**
 * Compute hrTSS using generic Bannister TRIMP normalized to 1hr at threshold.
 * This is the fallback when no learned model is available.
 */
function computeHrTss(
  durationMin: number,
  avgHr: number,
  maxHr: number,
  restingHr: number,
): number {
  const trimp = computeTrimp(durationMin, avgHr, maxHr, restingHr);
  if (trimp === 0) return 0;

  // Threshold HR at 85% of max HR
  const thresholdDeltaRatio = 0.85;
  const trimpOneHourAtThreshold =
    60 * thresholdDeltaRatio * 0.64 * Math.exp(1.92 * thresholdDeltaRatio);

  if (trimpOneHourAtThreshold === 0) return 0;
  return (trimp / trimpOneHourAtThreshold) * 100;
}

/**
 * Compute power-based TSS.
 * TSS = (avg_power / ftp)^2 * duration_hours * 100
 * Uses avg_power as NP approximation — the regression absorbs systematic bias.
 */
function computePowerTss(avgPower: number, ftp: number, durationMin: number): number {
  if (ftp <= 0 || durationMin <= 0 || avgPower <= 0) return 0;
  const intensityFactor = avgPower / ftp;
  return intensityFactor ** 2 * (durationMin / 60) * 100;
}

/**
 * Build a linear regression model: powerTss = slope * trimp + intercept.
 * Returns null if insufficient data or poor fit.
 */
function buildTssModel(
  paired: { trimp: number; powerTss: number }[],
): { slope: number; intercept: number; r2: number } | null {
  // Require at least 10 paired activities
  if (paired.length < 10) return null;

  const xs = paired.map((p) => p.trimp);
  const ys = paired.map((p) => p.powerTss);

  const result = linearRegression(xs, ys);

  // Require a reasonable fit (R² >= 0.3) and positive slope
  if (result.r2 < 0.3 || result.slope <= 0) return null;

  return result;
}

/**
 * Estimate FTP from activity data.
 * Uses highest avg_power from activities >= 20 min duration, multiplied by 0.95.
 */
function estimateFtp(activities: ActivityRow[]): number | null {
  const qualifying = activities.filter(
    (a) => a.avg_power != null && a.avg_power > 0 && a.duration_min >= 20,
  );
  if (qualifying.length === 0) return null;
  const bestAvgPower = Math.max(...qualifying.map((a) => Number(a.avg_power)));
  return Math.round(bestAvgPower * 0.95);
}

export const pmcRouter = router({
  /**
   * Performance Management Chart data.
   * Computes daily TSS using a learned regression model (power+HR paired activities)
   * when available, falling back to generic Bannister TRIMP normalization.
   * Derives CTL (42d), ATL (7d), TSB from daily TSS.
   */
  chart: publicProcedure
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<PmcChartResult> => {
      // Fetch extra history for EWMA warm-up (42 days for CTL)
      const queryDays = input.days + 42;

      // Get max HR, resting HR, and per-activity stats in one query
      const activityRows = await ctx.db.execute(
        sql`WITH max_hr AS (
              SELECT MAX(heart_rate) AS val
              FROM fitness.metric_stream
              WHERE heart_rate IS NOT NULL
                AND activity_id IS NOT NULL
            ),
            resting AS (
              SELECT resting_hr AS val
              FROM fitness.v_daily_metrics
              WHERE resting_hr IS NOT NULL
              ORDER BY date DESC
              LIMIT 1
            )
            SELECT
              (SELECT val FROM max_hr) AS global_max_hr,
              COALESCE((SELECT val FROM resting), 60) AS resting_hr,
              a.id,
              a.started_at::date AS date,
              EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60 AS duration_min,
              AVG(ms.heart_rate) AS avg_hr,
              MAX(ms.heart_rate) AS max_hr,
              AVG(ms.power) FILTER (WHERE ms.power > 0) AS avg_power,
              COUNT(*) FILTER (WHERE ms.power > 0) AS power_samples,
              COUNT(*) FILTER (WHERE ms.heart_rate IS NOT NULL) AS hr_samples
            FROM fitness.v_activity a
            CROSS JOIN max_hr
            JOIN fitness.metric_stream ms ON ms.activity_id = a.id
            WHERE max_hr.val IS NOT NULL
              AND a.started_at > NOW() - ${queryDays}::int * INTERVAL '1 day'
              AND a.ended_at IS NOT NULL
              AND ms.heart_rate IS NOT NULL
            GROUP BY a.id, a.started_at, a.ended_at, max_hr.val`,
      );

      interface CombinedActivityRow extends ActivityRow {
        global_max_hr: number | null;
        resting_hr: number;
      }
      const allRows = activityRows as unknown as CombinedActivityRow[];

      const globalMaxHr = allRows.length > 0 ? Number(allRows[0].global_max_hr) : null;
      if (!globalMaxHr) {
        return {
          data: [],
          model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
        };
      }

      const restingHr = allRows.length > 0 ? Number(allRows[0].resting_hr) : 60;
      const activities = allRows as unknown as ActivityRow[];

      // Estimate FTP from the data
      const ftp = estimateFtp(activities);

      // Build regression model from activities with both power and HR
      let tssModel: { slope: number; intercept: number; r2: number } | null = null;
      const pairedData: { trimp: number; powerTss: number }[] = [];

      if (ftp != null) {
        for (const act of activities) {
          const durationMin = Number(act.duration_min);
          const avgHr = Number(act.avg_hr);
          const avgPower = act.avg_power != null ? Number(act.avg_power) : null;
          const powerSamples = Number(act.power_samples);

          // Require meaningful power data (at least 60 samples ~ 1 min)
          if (avgPower != null && avgPower > 0 && powerSamples >= 60) {
            const trimp = computeTrimp(durationMin, avgHr, globalMaxHr, restingHr);
            const powerTss = computePowerTss(avgPower, ftp, durationMin);
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
        const avgPower = act.avg_power != null ? Number(act.avg_power) : null;
        const powerSamples = Number(act.power_samples);

        let tss: number;

        if (ftp != null && avgPower != null && avgPower > 0 && powerSamples >= 60) {
          // Activity has power data — use power TSS directly
          tss = computePowerTss(avgPower, ftp, durationMin);
        } else if (tssModel != null) {
          // Activity has only HR — use learned model to predict TSS from TRIMP
          const trimp = computeTrimp(durationMin, avgHr, globalMaxHr, restingHr);
          tss = Math.max(0, tssModel.slope * trimp + tssModel.intercept);
        } else {
          // Fallback: generic Bannister hrTSS
          tss = computeHrTss(durationMin, avgHr, globalMaxHr, restingHr);
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

      return { data: result, model: modelInfo };
    }),
});
