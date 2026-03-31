import type { PmcChartResult, PmcDataPoint, TssModelInfo } from "@dofek/training/pmc";
import { TrainingStressCalculator } from "@dofek/training/training-load";

import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

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

type ActivityRow = z.infer<typeof combinedActivityRowSchema>;

const normalizedPowerRowSchema = z.object({
  activity_id: z.string(),
  np: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access and computation for Performance Management Chart (PMC). */
export class PmcRepository extends BaseRepository {
  async getChart(days: number): Promise<PmcChartResult> {
    // Load personalized algorithm parameters
    const storedParams = await loadPersonalizedParams(this.db, this.userId);
    const effective = getEffectiveParams(storedParams);
    const { chronicTrainingLoadDays, acuteTrainingLoadDays } = effective.exponentialMovingAverage;
    const { genderFactor, exponent } = effective.trainingImpulseConstants;
    const calculator = new TrainingStressCalculator(genderFactor, exponent);

    // Fetch enough history for EWMA convergence, regardless of display range.
    const minHistoryDays = 365;
    const queryDays = Math.max(days, minHistoryDays) + chronicTrainingLoadDays;

    // QUERY 1: activities with max HR, resting HR
    const activityRows = await this.query(
      combinedActivityRowSchema,
      sql`SELECT
            up.max_hr AS global_max_hr,
            COALESCE(up.resting_hr, (
              SELECT resting_hr FROM fitness.v_daily_metrics
              WHERE user_id = ${this.userId} AND resting_hr IS NOT NULL ORDER BY date DESC LIMIT 1
            ), 60) AS resting_hr,
            asum.activity_id AS id,
            (asum.started_at AT TIME ZONE ${this.timezone})::date AS date,
            EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60 AS duration_min,
            asum.avg_hr,
            asum.max_hr,
            asum.avg_power,
            asum.power_sample_count AS power_samples,
            asum.hr_sample_count AS hr_samples
          FROM fitness.activity_summary asum
          JOIN fitness.user_profile up ON up.id = asum.user_id
          WHERE up.id = ${this.userId}
            AND up.max_hr IS NOT NULL
            AND asum.started_at > NOW() - ${queryDays}::int * INTERVAL '1 day'
            AND asum.ended_at IS NOT NULL
            AND asum.hr_sample_count > 0`,
    );

    const globalMaxHr = activityRows.length > 0 ? Number(activityRows[0]?.global_max_hr) : null;
    if (!globalMaxHr) {
      return {
        data: [],
        model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
      };
    }

    const restingHr = activityRows.length > 0 ? Number(activityRows[0]?.resting_hr) : 60;

    // QUERY 2: Normalized Power per activity from metric_stream
    const npRows = await this.query(
      normalizedPowerRowSchema,
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
            WHERE a.user_id = ${this.userId}
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
    const npByActivity = new Map(npRows.map((row) => [row.activity_id, Number(row.np)]));

    // Estimate FTP and build regression model
    const ftp = TrainingStressCalculator.estimateFtp(activityRows);
    const { tssModel, pairedData } = this.#buildRegressionModel(
      activityRows,
      npByActivity,
      ftp,
      calculator,
      globalMaxHr,
      restingHr,
    );

    // Compute TSS per activity and aggregate by day
    const dailyLoad = this.#computeDailyLoad(
      activityRows,
      npByActivity,
      ftp,
      tssModel,
      calculator,
      globalMaxHr,
      restingHr,
    );

    // Run EWMA and trim leading zeros
    const result = this.#computeEwma(
      dailyLoad,
      queryDays,
      days,
      chronicTrainingLoadDays,
      acuteTrainingLoadDays,
    );

    // Assemble model info
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
  }

  // ── Private helpers ─────────────────────────────────────────────────

  #buildRegressionModel(
    activities: ActivityRow[],
    npByActivity: Map<string, number>,
    ftp: number | null,
    calculator: TrainingStressCalculator,
    globalMaxHr: number,
    restingHr: number,
  ): {
    tssModel: { slope: number; intercept: number; r2: number } | null;
    pairedData: { trimp: number; powerTss: number }[];
  } {
    const pairedData: { trimp: number; powerTss: number }[] = [];

    if (ftp != null) {
      for (const activity of activities) {
        const durationMin = Number(activity.duration_min);
        const avgHr = Number(activity.avg_hr);
        const normalizedPower = npByActivity.get(activity.id);

        if (normalizedPower != null && normalizedPower > 0) {
          const trimp = calculator.computeTrimp(durationMin, avgHr, globalMaxHr, restingHr);
          const powerTss = TrainingStressCalculator.computePowerTss(
            normalizedPower,
            ftp,
            durationMin,
          );
          if (trimp > 0 && powerTss > 0) {
            pairedData.push({ trimp, powerTss });
          }
        }
      }
    }

    const tssModel = TrainingStressCalculator.buildTssModel(pairedData);
    return { tssModel, pairedData };
  }

  #computeDailyLoad(
    activities: ActivityRow[],
    npByActivity: Map<string, number>,
    ftp: number | null,
    tssModel: { slope: number; intercept: number; r2: number } | null,
    calculator: TrainingStressCalculator,
    globalMaxHr: number,
    restingHr: number,
  ): Map<string, number> {
    const dailyLoad = new Map<string, number>();

    for (const activity of activities) {
      const durationMin = Number(activity.duration_min);
      const avgHr = Number(activity.avg_hr);
      const normalizedPower = npByActivity.get(activity.id);

      let tss: number;

      if (ftp != null && normalizedPower != null && normalizedPower > 0) {
        tss = TrainingStressCalculator.computePowerTss(normalizedPower, ftp, durationMin);
      } else if (tssModel != null) {
        const trimp = calculator.computeTrimp(durationMin, avgHr, globalMaxHr, restingHr);
        tss = Math.max(0, tssModel.slope * trimp + tssModel.intercept);
      } else {
        tss = calculator.computeHrTss(durationMin, avgHr, globalMaxHr, restingHr);
      }

      const dateStr = String(activity.date);
      dailyLoad.set(dateStr, (dailyLoad.get(dateStr) ?? 0) + tss);
    }

    return dailyLoad;
  }

  #computeEwma(
    dailyLoad: Map<string, number>,
    queryDays: number,
    displayDays: number,
    chronicTrainingLoadDays: number,
    acuteTrainingLoadDays: number,
  ): PmcDataPoint[] {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - queryDays);
    const endDate = new Date();

    const result: PmcDataPoint[] = [];
    let ctl = 0;
    let atl = 0;

    const current = new Date(startDate);
    const warmUpDays = queryDays - displayDays;
    let dayIndex = 0;

    while (current <= endDate) {
      const dateStr = current.toISOString().split("T")[0] ?? "";
      const load = dailyLoad.get(dateStr) ?? 0;

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

    let firstMeaningfulIndex = result.findIndex((dataPoint) => dataPoint.ctl >= 0.1);
    if (firstMeaningfulIndex < 0) firstMeaningfulIndex = 0;
    return result.slice(firstMeaningfulIndex);
  }
}
