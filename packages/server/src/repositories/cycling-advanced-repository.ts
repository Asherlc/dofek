import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import type { Database } from "dofek/db";
import { z } from "zod";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { activityRepositoryFor } from "./activity-repository.ts";
import {
  ActivityVariabilityModel,
  PedalDynamicsModel,
  type RampRateResultData,
  RampRateWeekModel,
  TrainingMonotonyWeekModel,
  VerticalAscentModel,
} from "./cycling-advanced-models.ts";

const ENDURANCE_TYPES: string[] = [...ENDURANCE_ACTIVITY_TYPES];

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const rampRateRowSchema = z.object({
  week: dateStringSchema,
  ctl_start: z.coerce.number(),
  ctl_end: z.coerce.number(),
  ramp_rate: z.coerce.number(),
});

const monotonyRowSchema = z.object({
  week: dateStringSchema,
  monotony: z.coerce.number(),
  strain: z.coerce.number(),
  weekly_load: z.coerce.number(),
});

const ftpSchema = z.object({ ftp: z.coerce.number() });

const variabilityRowSchema = z.object({
  activity_id: z.string(),
  date: dateStringSchema,
  name: z.string(),
  np: z.coerce.number(),
  avg_power: z.coerce.number(),
  total_count: z.coerce.number(),
});

const vamRowSchema = z.object({
  date: dateStringSchema,
  name: z.string(),
  elevation_gain: z.coerce.number(),
  climbing_seconds: z.coerce.number(),
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

  /** Ramp rate: week-over-week CTL change based on HR TRIMP load. */
  async getRampRate(days: number): Promise<RampRateResultData> {
    const rows = await this.#sensorStore.query(
      rampRateRowSchema,
      `SELECT
        toString(ramp.week) AS week,
        ramp.ctl_start AS ctl_start,
        ramp.ctl_end AS ctl_end,
        ramp.ramp_rate AS ramp_rate
      FROM analytics.weekly_endurance_ramp_rate AS ramp FINAL
      WHERE ramp.user_id = {userId:UUID}
        AND ramp.is_deleted = 0
        AND ramp.week > toMonday(today() - INTERVAL {days:Int32} DAY)
      ORDER BY ramp.week`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
      },
    );

    if (rows.length === 0) return { weeks: [], currentRampRate: 0, recommendation: "No data" };

    const weeks = rows.map(
      (row) =>
        new RampRateWeekModel({
          week: row.week,
          ctlStart: row.ctl_start,
          ctlEnd: row.ctl_end,
          rampRate: row.ramp_rate,
        }),
    );

    const currentRampRate = weeks.length > 0 ? (weeks[weeks.length - 1]?.rampRate ?? 0) : 0;

    let recommendation: string;
    if (Math.abs(currentRampRate) < 5) {
      recommendation = "Safe: ramp rate is within sustainable range";
    } else if (Math.abs(currentRampRate) <= 7) {
      recommendation = "Aggressive: monitor fatigue closely and ensure recovery";
    } else {
      recommendation = "Danger: ramp rate is too high, risk of overtraining or injury";
    }

    return { weeks, currentRampRate, recommendation };
  }

  /** Training monotony: weekly monotony (mean daily load / stdev) and strain. */
  async getTrainingMonotony(days: number): Promise<TrainingMonotonyWeekModel[]> {
    const rows = await this.#sensorStore.query(
      monotonyRowSchema,
      `SELECT
        toString(monotony.week) AS week,
        monotony.monotony AS monotony,
        monotony.strain AS strain,
        monotony.weekly_load AS weekly_load
      FROM analytics.weekly_training_monotony AS monotony FINAL
      WHERE monotony.user_id = {userId:UUID}
        AND monotony.is_deleted = 0
        AND monotony.week >= toMonday(today() - INTERVAL {days:Int32} DAY)
      ORDER BY monotony.week`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
      },
    );

    return rows.map(
      (row) =>
        new TrainingMonotonyWeekModel({
          week: row.week,
          monotony: row.monotony,
          strain: row.strain,
          weeklyLoad: row.weekly_load,
        }),
    );
  }

  /** Estimate FTP as 95% of best 20-minute average power. */
  async getEstimatedFtp(days: number): Promise<number | null> {
    const ftpResult = await this.#sensorStore.query(
      ftpSchema,
      `SELECT
        round(max(asum.best_twenty_minute_power) * 0.95, 1) AS ftp
      FROM analytics.activity_summary asum
      WHERE asum.user_id = {userId:UUID}
        AND has({enduranceTypes:Array(String)}, asum.activity_type)
        AND asum.started_at > now() - INTERVAL {days:Int32} DAY
        AND asum.best_twenty_minute_power IS NOT NULL`,
      {
        userId: this.#userId,
        days,
        enduranceTypes: ENDURANCE_TYPES,
      },
    );
    return ftpResult[0]?.ftp ?? null;
  }

  /** Activity variability: NP, VI, IF per activity. */
  async getActivityVariability(
    days: number,
    limit: number,
    offset: number,
  ): Promise<{ models: ActivityVariabilityModel[]; totalCount: number }> {
    if ((await this.#loadRawActivityCount(days)) === 0) {
      return { models: [], totalCount: 0 };
    }

    const ftp = await this.getEstimatedFtp(days);
    if (!ftp) return { models: [], totalCount: 0 };

    const rows = await this.#sensorStore.query(
      variabilityRowSchema,
      `SELECT
        toString(asum.activity_id) AS activity_id,
        toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
        asum.name AS name,
        round(asum.normalized_power, 1) AS np,
        round(asum.smoothed_avg_power, 1) AS avg_power,
        toInt32(count() OVER ()) AS total_count
      FROM analytics.activity_summary asum
      WHERE asum.user_id = {userId:UUID}
        AND has({enduranceTypes:Array(String)}, asum.activity_type)
        AND asum.started_at > now() - INTERVAL {days:Int32} DAY
        AND asum.normalized_power IS NOT NULL
      ORDER BY asum.started_at DESC
      LIMIT {limit:Int32}
      OFFSET {offset:Int32}`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
        enduranceTypes: ENDURANCE_TYPES,
        limit,
        offset,
      },
    );

    const totalCount = rows[0]?.total_count ?? 0;

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
            ftp,
          ),
      ),
      totalCount,
    };
  }

  /** Vertical ascent rate (VAM) for climbing segments. Uses grade samples when
   *  available, falling back to altitude-only diffs otherwise. */
  async getVerticalAscentRates(days: number): Promise<VerticalAscentModel[]> {
    if ((await this.#loadRawActivityCount(days)) === 0) {
      return [];
    }

    const rows = await this.#sensorStore.query(
      vamRowSchema,
      `SELECT
        toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
        asum.name AS name,
        round(asum.climbing_elevation_gain_m, 1) AS elevation_gain,
        toInt32(asum.climbing_seconds) AS climbing_seconds
      FROM analytics.activity_summary asum
      WHERE asum.user_id = {userId:UUID}
        AND has({enduranceTypes:Array(String)}, asum.activity_type)
        AND asum.started_at > now() - INTERVAL {days:Int32} DAY
        AND asum.climbing_seconds > 60
      ORDER BY asum.started_at`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
        enduranceTypes: ENDURANCE_TYPES,
      },
    );

    return rows.map(
      (row) =>
        new VerticalAscentModel({
          date: row.date,
          activityName: row.name,
          elevationGainMeters: row.elevation_gain,
          climbingSeconds: row.climbing_seconds,
        }),
    );
  }

  /** Pedal dynamics: left/right balance, torque effectiveness, pedal smoothness. */
  async getPedalDynamics(days: number): Promise<PedalDynamicsModel[]> {
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
        AND has({enduranceTypes:Array(String)}, asum.activity_type)
        AND asum.started_at > now() - INTERVAL {days:Int32} DAY
        AND asum.avg_left_balance IS NOT NULL
      ORDER BY asum.started_at`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
        enduranceTypes: ENDURANCE_TYPES,
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

  async #loadRawActivityCount(days: number): Promise<number> {
    return activityRepositoryFor(this.#db, this.#userId).countVisibleInWindow({
      days,
      activityTypes: ENDURANCE_TYPES,
    });
  }
}
