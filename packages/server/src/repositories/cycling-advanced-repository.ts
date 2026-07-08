import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
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

const CYCLING_TYPES: string[] = [...CYCLING_ACTIVITY_TYPES];

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
      `WITH cycling_daily_load AS (
        SELECT
          load.user_id AS user_id,
          assumeNotNull(load.date) AS load_date,
          sum(load.training_load) AS training_load
        FROM analytics.daily_endurance_load AS load FINAL
        INNER JOIN analytics.activity_summary AS activity
          ON activity.activity_id = load.activity_id
         AND activity.user_id = load.user_id
        WHERE load.user_id = {userId:UUID}
          AND load.is_deleted = 0
          AND load.date IS NOT NULL
          AND has({activityTypes:Array(String)}, activity.activity_type)
        GROUP BY
          load.user_id,
          load_date
      ),
      date_bounds AS (
        SELECT
          user_id,
          min(load_date) AS first_load_date,
          max(load_date) AS latest_load_date
        FROM cycling_daily_load
        GROUP BY user_id
      ),
      date_series AS (
        SELECT
          user_id,
          first_load_date + INTERVAL date_offset DAY AS date
        FROM date_bounds
        ARRAY JOIN range(
          toUInt32(dateDiff('day', first_load_date, latest_load_date) + 1)
        ) AS date_offset
      ),
      ctl_by_date AS (
        SELECT
          date_series.user_id AS user_id,
          date_series.date AS date,
          sum(
            cycling_daily_load.training_load
            * (1.0 / 42.0)
            * pow(41.0 / 42.0, dateDiff('day', cycling_daily_load.load_date, date_series.date))
          ) AS ctl
        FROM date_series
        LEFT JOIN cycling_daily_load
          ON cycling_daily_load.user_id = date_series.user_id
         AND cycling_daily_load.load_date <= date_series.date
        GROUP BY
          date_series.user_id,
          date_series.date
      ),
      weekly_ctl AS (
        SELECT
          user_id,
          toMonday(date) AS week,
          argMax(ctl, date) AS ctl_end
        FROM ctl_by_date
        GROUP BY
          user_id,
          toMonday(date)
      ),
      weekly_with_previous AS (
        SELECT
          user_id,
          week,
          ctl_end,
          lagInFrame(toNullable(ctl_end), 1, CAST(NULL, 'Nullable(Float64)')) OVER (
            PARTITION BY user_id ORDER BY week
          ) AS previous_ctl_end
        FROM weekly_ctl
      ),
      ramp AS (
        SELECT
          user_id,
          week,
          round(previous_ctl_end, 2) AS ctl_start,
          round(ctl_end, 2) AS ctl_end,
          round(ctl_end - previous_ctl_end, 2) AS ramp_rate,
          0 AS is_deleted
        FROM weekly_with_previous
        WHERE previous_ctl_end IS NOT NULL
      )
      SELECT
        toString(ramp.week) AS week,
        ramp.ctl_start AS ctl_start,
        ramp.ctl_end AS ctl_end,
        ramp.ramp_rate AS ramp_rate
      FROM ramp
      WHERE ramp.user_id = {userId:UUID}
        AND ramp.is_deleted = 0
        AND ramp.week > toMonday(today() - INTERVAL {days:Int32} DAY)
      ORDER BY ramp.week`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
        activityTypes: CYCLING_TYPES,
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
      `WITH cycling_daily_load AS (
        SELECT
          load.user_id AS user_id,
          assumeNotNull(load.date) AS load_date,
          sum(load.training_load) AS training_load
        FROM analytics.daily_endurance_load AS load FINAL
        INNER JOIN analytics.activity_summary AS activity
          ON activity.activity_id = load.activity_id
         AND activity.user_id = load.user_id
        WHERE load.user_id = {userId:UUID}
          AND load.is_deleted = 0
          AND load.date IS NOT NULL
          AND has({activityTypes:Array(String)}, activity.activity_type)
        GROUP BY
          load.user_id,
          load_date
      ),
      week_bounds AS (
        SELECT
          user_id,
          toMonday(min(load_date)) AS first_week,
          toMonday(max(load_date)) AS latest_week
        FROM cycling_daily_load
        GROUP BY user_id
      ),
      calendar_dates AS (
        SELECT
          user_id,
          first_week + INTERVAL date_offset DAY AS load_date
        FROM week_bounds
        ARRAY JOIN range(toUInt32(dateDiff('day', first_week, latest_week + INTERVAL 6 DAY) + 1)) AS date_offset
      ),
      load_by_calendar_date AS (
        SELECT
          calendar_dates.user_id AS user_id,
          calendar_dates.load_date AS load_date,
          coalesce(cycling_daily_load.training_load, 0) AS training_load
        FROM calendar_dates
        LEFT JOIN cycling_daily_load
          ON cycling_daily_load.user_id = calendar_dates.user_id
         AND cycling_daily_load.load_date = calendar_dates.load_date
      ),
      weekly_stats AS (
        SELECT
          user_id,
          toMonday(load_date) AS week,
          avg(training_load) AS mean_load,
          stddevPop(training_load) AS stdev_load,
          sum(training_load) AS weekly_load
        FROM load_by_calendar_date
        GROUP BY
          user_id,
          toMonday(load_date)
        HAVING stddevPop(training_load) > 1e-6
      ),
      monotony AS (
        SELECT
          user_id,
          week,
          round(mean_load / stdev_load, 2) AS monotony,
          round(weekly_load * (mean_load / stdev_load), 1) AS strain,
          round(weekly_load, 1) AS weekly_load,
          0 AS is_deleted
        FROM weekly_stats
      )
      SELECT
        toString(monotony.week) AS week,
        monotony.monotony AS monotony,
        monotony.strain AS strain,
        monotony.weekly_load AS weekly_load
      FROM monotony
      WHERE monotony.user_id = {userId:UUID}
        AND monotony.is_deleted = 0
        AND monotony.week >= toMonday(today() - INTERVAL {days:Int32} DAY)
      ORDER BY monotony.week`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
        activityTypes: CYCLING_TYPES,
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
        AND has({activityTypes:Array(String)}, asum.activity_type)
        AND asum.started_at > now() - INTERVAL {days:Int32} DAY
        AND asum.best_twenty_minute_power IS NOT NULL`,
      {
        userId: this.#userId,
        days,
        activityTypes: CYCLING_TYPES,
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
        AND has({activityTypes:Array(String)}, asum.activity_type)
        AND asum.started_at > now() - INTERVAL {days:Int32} DAY
        AND asum.normalized_power IS NOT NULL
      ORDER BY asum.started_at DESC
      LIMIT {limit:Int32}
      OFFSET {offset:Int32}`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
        activityTypes: CYCLING_TYPES,
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
        AND has({activityTypes:Array(String)}, asum.activity_type)
        AND asum.started_at > now() - INTERVAL {days:Int32} DAY
        AND asum.climbing_seconds > 60
      ORDER BY asum.started_at`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
        activityTypes: CYCLING_TYPES,
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
        AND has({activityTypes:Array(String)}, asum.activity_type)
        AND asum.started_at > now() - INTERVAL {days:Int32} DAY
        AND asum.avg_left_balance IS NOT NULL
      ORDER BY asum.started_at`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
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

  async #loadRawActivityCount(days: number): Promise<number> {
    return activityRepositoryFor(this.#db, this.#userId).countVisibleInWindow({
      days,
      activityTypes: CYCLING_TYPES,
    });
  }
}
