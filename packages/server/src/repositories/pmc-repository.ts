import type { PmcChartResult, PmcDataPoint, TssModelInfo } from "@dofek/training/pmc";
import { TrainingStressCalculator } from "@dofek/training/training-load";

import type { Database } from "dofek/db";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

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
  readonly #sensorStore: ActivitySensorStore;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorStore,
    accessWindow?: ConstructorParameters<typeof BaseRepository>[3],
  ) {
    super(db, userId, timezone, accessWindow);
    this.#sensorStore = sensorStore;
  }

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

    // QUERY 1: activities with HR data from analytics.activity_summary in CH.
    // user_profile and derived_resting_heart_rate are accessed via FDW.
    // Sample counts come from analytics.deduped_sensor since CH activity_summary
    // doesn't carry per-channel sample counts.
    const activityRows = await this.#sensorStore.query(
      combinedActivityRowSchema,
      `WITH user_baseline AS (
        SELECT
          coalesce(up.max_hr, (
            SELECT max(max_hr) FROM analytics.activity_summary
            WHERE user_id = {userId:UUID} AND max_hr IS NOT NULL
          )) AS global_max_hr,
          coalesce(up.resting_hr, (
            SELECT resting_hr FROM postgres_fitness_live.derived_resting_heart_rate
            WHERE user_id = {userId:UUID} AND resting_hr IS NOT NULL
            ORDER BY date DESC LIMIT 1
          ), 60) AS resting_hr
        FROM postgres_fitness_live.user_profile up
        WHERE up.id = {userId:UUID}
      ),
      sample_counts AS (
        SELECT
          activity_id,
          countIf(channel = 'power') AS power_samples,
          countIf(channel = 'heart_rate') AS hr_samples
        FROM analytics.deduped_sensor
        WHERE user_id = {userId:UUID}
        GROUP BY activity_id
      )
      SELECT
        ub.global_max_hr AS global_max_hr,
        ub.resting_hr AS resting_hr,
        toString(asum.activity_id) AS id,
        toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
        dateDiff('second', asum.started_at, asum.ended_at) / 60 AS duration_min,
        asum.avg_hr AS avg_hr,
        asum.max_hr AS max_hr,
        asum.avg_power AS avg_power,
        coalesce(sc.power_samples, 0) AS power_samples,
        coalesce(sc.hr_samples, 0) AS hr_samples
      FROM analytics.activity_summary asum
      CROSS JOIN user_baseline ub
      LEFT JOIN sample_counts sc ON sc.activity_id = asum.activity_id
      WHERE asum.user_id = {userId:UUID}
        AND asum.started_at > now() - INTERVAL {queryDays:Int32} DAY
        AND asum.ended_at IS NOT NULL
        AND coalesce(sc.hr_samples, 0) > 0`,
      { userId: this.userId, timezone: this.timezone, queryDays },
    );

    const globalMaxHr = activityRows.length > 0 ? Number(activityRows[0]?.global_max_hr) : null;
    if (!globalMaxHr) {
      return {
        data: [],
        model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
      };
    }

    const restingHr = activityRows.length > 0 ? Number(activityRows[0]?.resting_hr) : 60;

    // QUERY 2: Normalized Power per activity from analytics.deduped_sensor.
    const npRows = await this.#sensorStore.query(
      normalizedPowerRowSchema,
      `WITH rolling AS (
        SELECT
          ds.activity_id AS activity_id,
          avg(ds.scalar) OVER (
            PARTITION BY ds.activity_id
            ORDER BY ds.recorded_at
            RANGE BETWEEN 29 PRECEDING AND CURRENT ROW
          ) AS rolling_30s_power
        FROM analytics.deduped_sensor ds
        INNER JOIN postgres_fitness_live.v_activity a ON a.id = ds.activity_id
        WHERE ds.user_id = {userId:UUID}
          AND a.started_at > now() - INTERVAL {queryDays:Int32} DAY
          AND ds.channel = 'power'
          AND ds.scalar > 0
      )
      SELECT
        toString(activity_id) AS activity_id,
        round(pow(avg(pow(rolling_30s_power, 4)), 0.25), 1) AS np
      FROM rolling
      GROUP BY activity_id
      HAVING count() >= 60`,
      { userId: this.userId, queryDays },
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
