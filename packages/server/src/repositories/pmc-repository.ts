import type { PmcChartResult, PmcDataPoint, TssModelInfo } from "@dofek/training/pmc";
import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import { TrainingStressCalculator } from "@dofek/training/training-load";

import type { Database } from "dofek/db";
import { type EffectiveParams, getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { ChartRange } from "../lib/chart-range.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { activityRepositoryFor } from "./activity-repository.ts";
import { PmcChartCalculator } from "./pmc-chart-calculator.ts";
import {
  type PmcActivityRow,
  type PmcNormalizedPowerRow,
  PmcTrainingLoadCalculator,
} from "./pmc-training-load-calculator.ts";
import { restingHeartRateClickHouseCte } from "./resting-heart-rate-query.ts";

const CYCLING_TYPES: string[] = [...CYCLING_ACTIVITY_TYPES];

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

export async function buildPmcChartFromRows(input: {
  db: Pick<Database, "execute">;
  userId: string;
  range: ChartRange;
  activityRows: PmcActivityRow[];
  normalizedPowerRows: PmcNormalizedPowerRow[];
  parameters?: PmcChartParameters;
}): Promise<PmcRepositoryChartResult> {
  const parameters =
    input.parameters ?? (await loadPmcChartParameters(input.db, input.userId, input.range));
  const { effective, queryRange } = parameters;
  const { chronicTrainingLoadDays, acuteTrainingLoadDays } = effective.exponentialMovingAverage;
  const { genderFactor, exponent } = effective.trainingImpulseConstants;
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
  const allTimeActivityDays = daysSinceEarliestActivity(input.activityRows);
  return chartCalculator.buildChart({
    activityRows: input.activityRows,
    normalizedPowerRows: input.normalizedPowerRows,
    queryDays: queryRange.days ?? allTimeActivityDays,
    displayDays: input.range.days ?? allTimeActivityDays,
  });
}

export interface PmcChartParameters {
  effective: EffectiveParams;
  queryRange: ChartRange;
}

export async function loadPmcChartParameters(
  db: Pick<Database, "execute">,
  userId: string,
  range: ChartRange,
): Promise<PmcChartParameters> {
  const storedParams = await loadPersonalizedParams(db, userId);
  const effective = getEffectiveParams(storedParams);
  const displayRangeBaseDays = range.days === null ? null : Math.max(range.days, 365);
  return {
    effective,
    queryRange: ChartRange.fromDays(displayRangeBaseDays).withWarmupDays(
      effective.exponentialMovingAverage.chronicTrainingLoadDays,
    ),
  };
}

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

  async getChart(range: ChartRange): Promise<PmcRepositoryChartResult> {
    // Fetch enough history for EWMA convergence, regardless of display range.
    const parameters = await loadPmcChartParameters(this.db, this.userId, range);
    const { queryRange } = parameters;
    const today = new Date().toISOString().slice(0, 10);

    if ((await this.#loadRawActivityCount(queryRange)) === 0) {
      return {
        data: [],
        model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
      };
    }

    const activityRangeFilter = queryRange.clickHouseTimestampAfter("asum.started_at", "queryDays");
    const rhrWindowStart = queryRange.windowStartString(today);
    // QUERY 1: activities with HR data from analytics.activity_summary in CH.
    // user_profile is accessed via ClickHouse read models.
    // Sample counts come from the activity summary read model; do not recompute
    // them by joining deduped_sensor on the request path.
    const activityRows = await this.#sensorStore.query(
      combinedActivityRowSchema,
      `WITH ${restingHeartRateClickHouseCte({ includeWindowStart: !queryRange.isAll() })},
      user_baseline AS (
        SELECT
          coalesce(nullIf(up.max_hr, 0), (
            SELECT maxIf(max_hr, max_hr > 0) FROM analytics.activity_summary
            WHERE user_id = {userId:UUID}
              AND has({activityTypes:Array(String)}, canonical_type)
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
        ${activityRangeFilter}
        AND has({activityTypes:Array(String)}, asum.canonical_type)
        AND asum.ended_at IS NOT NULL
        AND coalesce(asum.hr_sample_count, 0) > 0`,
      {
        userId: this.userId,
        timezone: this.timezone,
        ...queryRange.clickHouseParams("queryDays"),
        activityTypes: CYCLING_TYPES,
        rhrEndDate: today,
        ...(rhrWindowStart ? { rhrWindowStart } : {}),
      },
    );

    const visibleActivityRows = await activityRepositoryFor(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).filterToVisibleActivities(activityRows);

    // QUERY 2: Normalized Power per activity from activity_summary (pre-computed by dbt).
    const normalizedPowerRows = await this.#sensorStore.query(
      normalizedPowerRowSchema,
      `SELECT
        toString(activity_id) AS activity_id,
        round(normalized_power, 1) AS np
      FROM analytics.activity_summary
      WHERE user_id = {userId:UUID}
        ${queryRange.clickHouseTimestampAfter("started_at", "queryDays")}
        AND has({activityTypes:Array(String)}, canonical_type)
        AND normalized_power IS NOT NULL`,
      {
        userId: this.userId,
        ...queryRange.clickHouseParams("queryDays"),
        activityTypes: CYCLING_TYPES,
      },
    );

    return buildPmcChartFromRows({
      db: this.db,
      userId: this.userId,
      range,
      activityRows: visibleActivityRows,
      normalizedPowerRows,
      parameters,
    });
  }

  async #loadRawActivityCount(range: ChartRange): Promise<number> {
    return activityRepositoryFor(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).countVisibleInWindow({
      days: range.days,
      activityTypes: CYCLING_TYPES,
    });
  }
}

function daysSinceEarliestActivity(activityRows: Array<{ date: string }>): number {
  const earliestDate = activityRows
    .map((row) => row.date)
    .sort((left, right) => left.localeCompare(right))[0];
  if (!earliestDate) return 0;
  const earliest = new Date(`${earliestDate}T00:00:00Z`).getTime();
  const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
  return Math.max(0, Math.ceil((today - earliest) / 86_400_000));
}
