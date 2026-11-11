import { ACTIVITY_MODALITIES } from "@dofek/training/activity-types";
import { isIndoorCyclingModality } from "@dofek/training/endurance-types";
import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import type { Database } from "dofek/db";
import { z } from "zod";
import {
  clickHouseIntervalDayLowerBound,
  type RangeDays,
  rangeDaysParams,
} from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { activityRepositoryFor } from "./activity-repository.ts";
import {
  ActivityVariabilityModel,
  PedalDynamicsModel,
  VerticalAscentModel,
} from "./cycling-advanced-models.ts";

const CYCLING_TYPES: string[] = [...CYCLING_ACTIVITY_TYPES];

export type ActivityVariabilityEmptyReason =
  | "no_cycling_activities"
  | "no_ftp_estimate"
  | "no_normalized_power";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const variabilityRowSchema = z.object({
  activity_id: z.string(),
  date: dateStringSchema,
  name: z.string(),
  np: z.coerce.number(),
  avg_power: z.coerce.number(),
  intensity_factor: z.coerce.number(),
  total_count: z.coerce.number(),
});

const variabilityCountSchema = z.object({
  total: z.coerce.number(),
  power_total: z.coerce.number(),
});

const vamRowSchema = z.object({
  activity_id: z.string(),
  date: dateStringSchema,
  name: z.string(),
  canonical_type: z.string(),
  modality: z.enum(ACTIVITY_MODALITIES).nullable(),
  elevation_gain: z.coerce.number(),
  elapsed_seconds: z.coerce.number(),
});

const pedalRowSchema = z.object({
  date: dateStringSchema,
  name: z.string(),
  avg_balance: z.coerce.number(),
  avg_torque_effectiveness: z.coerce.number(),
  avg_pedal_smoothness: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for advanced cycling analytics. */
export class CyclingAdvancedRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore: ActivitySensorStore;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorStore,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
  }

  /** Activity variability: NP, VI, IF per activity. */
  async getActivityVariability(
    days: RangeDays,
    limit: number,
    offset: number,
  ): Promise<{
    models: ActivityVariabilityModel[];
    totalCount: number;
    emptyReason: ActivityVariabilityEmptyReason | null;
  }> {
    if ((await this.#loadRawActivityCount(days)) === 0) {
      return { models: [], totalCount: 0, emptyReason: "no_cycling_activities" };
    }

    const rangeFilter = clickHouseIntervalDayLowerBound(days, "asum.started_at");
    const rows = await this.#sensorStore.query(
      variabilityRowSchema,
      `SELECT
        toString(asum.activity_id) AS activity_id,
        toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
        asum.name AS name,
        round(metrics.normalized_power, 1) AS np,
        metrics.intensity_factor AS intensity_factor,
        round(asum.smoothed_avg_power, 1) AS avg_power,
        toInt32(count() OVER ()) AS total_count
      FROM analytics.activity_summary asum
      INNER JOIN analytics.cycling_activity_power_metrics metrics
        ON metrics.user_id = asum.user_id AND metrics.activity_id = asum.activity_id
      WHERE asum.user_id = {userId:UUID}
        AND has({activityTypes:Array(String)}, asum.canonical_type)
        ${rangeFilter}
        AND metrics.normalized_power IS NOT NULL
        AND metrics.intensity_factor IS NOT NULL
      ORDER BY asum.started_at DESC
      LIMIT {limit:Int32}
      OFFSET {offset:Int32}`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...rangeDaysParams(days),
        activityTypes: CYCLING_TYPES,
        limit,
        offset,
      },
    );

    let totalCount = rows[0]?.total_count ?? 0;
    let emptyReason: ActivityVariabilityEmptyReason | null = null;

    if (rows.length === 0) {
      // The count() OVER () total is absent on an empty page, so it cannot
      // distinguish "no normalized power data" from "offset past the data".
      // Re-query the count so pagination stays correct and the UI shows the
      // right empty state instead of a misleading "no_normalized_power".
      const countRows = await this.#sensorStore.query(
        variabilityCountSchema,
        `SELECT countIf(metrics.intensity_factor IS NOT NULL) AS total, count() AS power_total
        FROM analytics.activity_summary asum
        INNER JOIN analytics.cycling_activity_power_metrics metrics
          ON metrics.user_id = asum.user_id AND metrics.activity_id = asum.activity_id
        WHERE asum.user_id = {userId:UUID}
          AND has({activityTypes:Array(String)}, asum.canonical_type)
          ${rangeFilter}
          AND metrics.normalized_power IS NOT NULL`,
        {
          userId: this.#userId,
          ...rangeDaysParams(days),
          activityTypes: CYCLING_TYPES,
        },
      );
      totalCount = countRows[0]?.total ?? 0;
      emptyReason =
        totalCount === 0
          ? (countRows[0]?.power_total ?? 0) > 0
            ? "no_ftp_estimate"
            : "no_normalized_power"
          : null;
    }

    return {
      models: rows.map(
        (row) =>
          new ActivityVariabilityModel(
            {
              activityId: row.activity_id,
              date: row.date,
              activityName: row.name,
              normalizedPower: row.np,
              averagePower: row.avg_power,
            },
            row.intensity_factor,
          ),
      ),
      totalCount,
      emptyReason,
    };
  }

  /** Whole-activity vertical ascent rate (VAM) from elevation gain over elapsed duration. */
  async getVerticalAscentRates(days: RangeDays): Promise<VerticalAscentModel[]> {
    if ((await this.#loadRawActivityCount(days)) === 0) {
      return [];
    }

    const rangeFilter = clickHouseIntervalDayLowerBound(days, "asum.started_at");
    const rows = await this.#sensorStore.query(
      vamRowSchema,
      `SELECT
        toString(asum.activity_id) AS activity_id,
        toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
        coalesce(nullIf(asum.name, ''), asum.canonical_type) AS name,
        asum.canonical_type AS canonical_type,
        asum.modality AS modality,
        round(asum.elevation_gain_m, 1) AS elevation_gain,
        greatest(toInt32(dateDiff('second', asum.started_at, asum.ended_at)), 0) AS elapsed_seconds
      FROM analytics.activity_summary asum
      WHERE asum.user_id = {userId:UUID}
        AND has({activityTypes:Array(String)}, asum.canonical_type)
        ${rangeFilter}
        AND asum.elevation_gain_m > 0
      ORDER BY asum.started_at`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...rangeDaysParams(days),
        activityTypes: CYCLING_TYPES,
      },
    );

    return rows
      .filter((row) => !isIndoorCyclingModality(row.modality))
      .map(
        (row) =>
          new VerticalAscentModel({
            activityId: row.activity_id,
            date: row.date,
            activityName: row.name,
            activityType: row.canonical_type,
            modality: row.modality,
            elevationGainMeters: row.elevation_gain,
            elapsedSeconds: row.elapsed_seconds,
          }),
      );
  }

  /** Pedal dynamics: left/right balance, torque effectiveness, pedal smoothness. */
  async getPedalDynamics(days: RangeDays): Promise<PedalDynamicsModel[]> {
    const rangeFilter = clickHouseIntervalDayLowerBound(days, "asum.started_at");
    const rows = await this.#sensorStore.query(
      pedalRowSchema,
      `SELECT
        toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
        asum.name AS name,
        round(asum.avg_left_balance, 1) AS avg_balance,
        round((asum.avg_left_torque_eff + asum.avg_right_torque_eff) / 2, 1) AS avg_torque_effectiveness,
        round((asum.avg_left_pedal_smooth + asum.avg_right_pedal_smooth) / 2, 1) AS avg_pedal_smoothness
      FROM analytics.activity_summary asum
      INNER JOIN analytics.v_activity va
        ON va.id = asum.activity_id
       AND va.user_id = asum.user_id
      WHERE asum.user_id = {userId:UUID}
        AND has({activityTypes:Array(String)}, asum.canonical_type)
        ${rangeFilter}
        AND asum.avg_left_balance IS NOT NULL
      ORDER BY asum.started_at`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...rangeDaysParams(days),
        activityTypes: CYCLING_TYPES,
      },
    );

    return rows.map(
      (row) =>
        new PedalDynamicsModel({
          date: row.date,
          activityName: row.name,
          leftRightBalance: row.avg_balance,
          avgTorqueEffectiveness: row.avg_torque_effectiveness,
          avgPedalSmoothness: row.avg_pedal_smoothness,
        }),
    );
  }

  async #loadRawActivityCount(days: RangeDays): Promise<number> {
    return activityRepositoryFor(this.#db, this.#userId).countVisibleInWindow({
      days,
      activityTypes: CYCLING_TYPES,
    });
  }
}
