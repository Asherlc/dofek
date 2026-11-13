import type { PmcChartResult, PmcDataPoint, TssModelInfo } from "@dofek/training/pmc";
import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";

import type { Database } from "dofek/db";
import { type EffectiveParams, getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { ChartRange } from "../lib/chart-range.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { activityRepositoryFor } from "./activity-repository.ts";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";
import { PmcChartCalculator } from "./pmc-chart-calculator.ts";
import {
  type PmcActivityRow,
  type PmcNormalizedPowerRow,
  PmcTrainingLoadCalculator,
} from "./pmc-training-load-calculator.ts";

const CYCLING_TYPES: string[] = [...CYCLING_ACTIVITY_TYPES];

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const combinedActivityRowSchema = z.object({
  id: z.string(),
  date: z.string(),
});

const normalizedPowerRowSchema = z.object({
  activity_id: z.string(),
  power_tss: z.coerce.number().nullable(),
});

type PmcRepositoryChartResult = PmcChartResult & {
  unavailableReason: string | null;
  data: PmcDataPoint[];
  model: TssModelInfo;
};

export async function buildPmcChartFromRows(input: {
  db: Pick<Database, "execute">;
  userId: string;
  range: ChartRange;
  currentEftp: number | null;
  activityRows: PmcActivityRow[];
  normalizedPowerRows: PmcNormalizedPowerRow[];
  parameters?: PmcChartParameters;
}): Promise<PmcRepositoryChartResult> {
  const parameters =
    input.parameters ?? (await loadPmcChartParameters(input.db, input.userId, input.range));
  const { effective, queryRange } = parameters;
  const { chronicTrainingLoadDays, acuteTrainingLoadDays } = effective.exponentialMovingAverage;
  const trainingLoadCalculator = new PmcTrainingLoadCalculator();
  const chartCalculator = new PmcChartCalculator({
    chronicTrainingLoadDays,
    acuteTrainingLoadDays,
    trainingLoadCalculator,
  });
  const allTimeActivityDays = daysSinceEarliestActivity(input.activityRows);
  return chartCalculator.buildChart({
    currentEftp: input.currentEftp,
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

    if ((await this.#loadRawActivityCount(queryRange)) === 0) {
      return {
        data: [],
        unavailableReason: null,
        model: { ftp: null },
      };
    }

    const activityRangeFilter = queryRange.clickHouseTimestampAfter("asum.started_at", "queryDays");
    const activityRows = await this.#sensorStore.query(
      combinedActivityRowSchema,
      `SELECT
        toString(asum.activity_id) AS id,
        toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date
      FROM analytics.activity_summary asum
      WHERE asum.user_id = {userId:UUID}
        ${activityRangeFilter}
        AND has({activityTypes:Array(String)}, asum.canonical_type)
        AND asum.ended_at IS NOT NULL`,
      {
        userId: this.userId,
        timezone: this.timezone,
        ...queryRange.clickHouseParams("queryDays"),
        activityTypes: CYCLING_TYPES,
      },
    );

    const visibleActivityRows = await activityRepositoryFor(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).filterToVisibleActivities(activityRows);

    // Canonical per-activity stress retains the threshold applicable to each ride.
    const normalizedPowerRows = await this.#sensorStore.query(
      normalizedPowerRowSchema,
      `SELECT
        toString(activity_id) AS activity_id,
        power_tss
      FROM analytics.cycling_activity_power_metrics
      WHERE user_id = {userId:UUID}
        ${queryRange.clickHouseTimestampAfter("started_at", "queryDays")}
      ORDER BY started_at`,
      {
        userId: this.userId,
        ...queryRange.clickHouseParams("queryDays"),
        activityTypes: CYCLING_TYPES,
      },
    );

    const currentThreshold = await new CyclingThresholdRepository(
      this.#sensorStore,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).getCurrent();

    return buildPmcChartFromRows({
      db: this.db,
      userId: this.userId,
      range,
      currentEftp: currentThreshold.value,
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
