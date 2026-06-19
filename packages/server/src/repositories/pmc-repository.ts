import type { PmcChartResult, PmcDataPoint, TssModelInfo } from "@dofek/training/pmc";
import { TrainingStressCalculator } from "@dofek/training/training-load";

import type { Database } from "dofek/db";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { PmcChartCalculator } from "./pmc-chart-calculator.ts";
import { PmcTrainingLoadCalculator } from "./pmc-training-load-calculator.ts";
import { activityRepositoryFor } from "./activity-repository.ts";
import { restingHeartRateClickHouseCte } from "./resting-heart-rate-query.ts";

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

const normalizedPowerRowSchema = z.object({
  activity_id: z.string(),
  np: z.coerce.number(),
});

type PmcRepositoryChartResult = PmcChartResult & {
  data: PmcDataPoint[];
  model: TssModelInfo;
};

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

  async getChart(days: number): Promise<PmcRepositoryChartResult> {
    // Load personalized algorithm parameters
    const storedParams = await loadPersonalizedParams(this.db, this.userId);
    const effective = getEffectiveParams(storedParams);
    const { chronicTrainingLoadDays, acuteTrainingLoadDays } = effective.exponentialMovingAverage;
    const { genderFactor, exponent } = effective.trainingImpulseConstants;

    // Fetch enough history for EWMA convergence, regardless of display range.
    const minHistoryDays = 365;
    const queryDays = Math.max(days, minHistoryDays) + chronicTrainingLoadDays;
    const today = new Date().toISOString().slice(0, 10);

    if ((await this.#loadRawActivityCount(queryDays)) === 0) {
      return {
        data: [],
        model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
      };
    }

    // QUERY 1: activities with HR data from analytics.activity_summary in CH.
    // user_profile is accessed via ClickHouse read models.
    // Sample counts come from the activity summary read model; do not recompute
    // them by joining deduped_sensor on the request path.
    const activityRows = await this.#sensorStore.query(
      combinedActivityRowSchema,
      `WITH ${restingHeartRateClickHouseCte()},
      user_baseline AS (
        SELECT
          coalesce(nullIf(up.max_hr, 0), (
            SELECT maxIf(max_hr, max_hr > 0) FROM analytics.activity_summary
            WHERE user_id = {userId:UUID}
          )) AS global_max_hr,
          coalesce(nullIf(up.resting_hr, 0), (
            SELECT resting_hr FROM resting_heart_rate
            WHERE resting_hr IS NOT NULL AND resting_hr > 0
            ORDER BY date DESC LIMIT 1
          ), 60) AS resting_hr
        FROM postgres_fitness.user_profile_current up
        WHERE up.id = {userId:UUID}
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
        coalesce(asum.power_sample_count, 0) AS power_samples,
        coalesce(asum.hr_sample_count, 0) AS hr_samples
      FROM analytics.activity_summary asum
      CROSS JOIN user_baseline ub
      WHERE asum.user_id = {userId:UUID}
        AND asum.started_at > now() - INTERVAL {queryDays:Int32} DAY
        AND asum.ended_at IS NOT NULL
        AND coalesce(asum.hr_sample_count, 0) > 0`,
      {
        userId: this.userId,
        timezone: this.timezone,
        queryDays,
        rhrEndDate: today,
        rhrWindowStart: dateWindowStartString(today, queryDays),
      },
    );

    const visibleActivityRows = await activityRepositoryFor(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).filterToVisibleActivities(activityRows);

    // QUERY 2: Normalized Power per activity from analytics.deduped_sensor.
    const normalizedPowerRows = await this.#sensorStore.query(
      normalizedPowerRowSchema,
      `WITH rolling AS (
        SELECT
          a.id AS activity_id,
          avg(ds.scalar) OVER (
            PARTITION BY a.id
            ORDER BY toUnixTimestamp(ds.recorded_at)
            RANGE BETWEEN 29 PRECEDING AND CURRENT ROW
          ) AS rolling_30s_power
        FROM analytics.deduped_sensor ds
        INNER JOIN analytics.v_activity a
          ON a.user_id = ds.user_id
         AND a.id = ds.activity_id
         AND ds.recorded_at >= a.started_at
         AND ds.recorded_at <= coalesce(a.ended_at, a.started_at + INTERVAL 12 HOUR)
        WHERE ds.user_id = {userId:UUID}
          AND a.started_at > now() - INTERVAL {queryDays:Int32} DAY
          AND ds.channel = 'power'
          AND ds.scalar > 0
          AND ds.is_deleted = 0
      )
      SELECT
        toString(activity_id) AS activity_id,
        round(pow(avg(pow(rolling_30s_power, 4)), 0.25), 1) AS np
      FROM rolling
      GROUP BY activity_id
      HAVING count() >= 60`,
      { userId: this.userId, queryDays },
    );

    const trainingStressCalculator = new TrainingStressCalculator(genderFactor, exponent);
    const trainingLoadCalculator = new PmcTrainingLoadCalculator({
      estimateThresholdPower: TrainingStressCalculator.estimateFtp,
      computeTrainingImpulse: (durationMin, avgHr, maxHr, restingHr) =>
        trainingStressCalculator.computeTrimp(durationMin, avgHr, maxHr, restingHr),
      computePowerTrainingStressScore: TrainingStressCalculator.computePowerTss,
      computeHeartRateTrainingStressScore: (durationMin, avgHr, maxHr, restingHr) =>
        trainingStressCalculator.computeHrTss(durationMin, avgHr, maxHr, restingHr),
      buildTrainingStressModel: TrainingStressCalculator.buildTssModel,
    });

    const chartCalculator = new PmcChartCalculator({
      chronicTrainingLoadDays,
      acuteTrainingLoadDays,
      trainingLoadCalculator,
    });
    return chartCalculator.buildChart({
      activityRows: visibleActivityRows,
      normalizedPowerRows,
      queryDays,
      displayDays: days,
    });
  }

  async #loadRawActivityCount(days: number): Promise<number> {
    return activityRepositoryFor(this.db, this.userId, this.timezone, this.accessWindow).countVisibleInWindow(
      {
        days,
      },
    );
  }
}
