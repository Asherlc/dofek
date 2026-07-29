import { isIndoorCyclingModality } from "@dofek/training/endurance-types";
import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import type { Database } from "dofek/db";
import { z } from "zod";
import {
  clickHouseDateRangeLowerBound,
  clickHouseIntervalDayLowerBound,
  clickHouseMondayDateRangeLowerBound,
  type RangeDays,
  rangeDaysOrNullAdd,
  rangeDaysParams,
} from "../lib/date-window.ts";
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

export type ActivityVariabilityEmptyReason =
  | "no_cycling_activities"
  | "no_ftp_estimate"
  | "no_normalized_power";

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
  daily_mean_load: z.coerce.number(),
  daily_load_standard_deviation: z.coerce.number(),
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

const variabilityCountSchema = z.object({ total: z.coerce.number() });

const vamRowSchema = z.object({
  date: dateStringSchema,
  name: z.string(),
  canonical_type: z.string(),
  modality: z.string().nullable(),
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

  /** Ramp rate: week-over-week CTL change based on HR TRIMP load. */
  async getRampRate(days: RangeDays): Promise<RampRateResultData> {
    const loadDays = rangeDaysOrNullAdd(days, 42);
    const loadRangeFilter = clickHouseDateRangeLowerBound(loadDays, "load.date", "loadDays");
    const displayRangeFilter = clickHouseMondayDateRangeLowerBound(days, "ramp.week");
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
          ${loadRangeFilter}
          AND has({activityTypes:Array(String)}, activity.canonical_type)
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
        ${displayRangeFilter}
      ORDER BY ramp.week`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...rangeDaysParams(days),
        ...rangeDaysParams(loadDays, "loadDays"),
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
  async getTrainingMonotony(days: RangeDays): Promise<TrainingMonotonyWeekModel[]> {
    const rangeFilter = clickHouseMondayDateRangeLowerBound(days, "monotony.week", "days", ">=");
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
          AND has({activityTypes:Array(String)}, activity.canonical_type)
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
          round(mean_load, 2) AS daily_mean_load,
          round(stdev_load, 2) AS daily_load_standard_deviation,
          0 AS is_deleted
        FROM weekly_stats
      )
      SELECT
        toString(monotony.week) AS week,
        monotony.monotony AS monotony,
        monotony.strain AS strain,
        monotony.weekly_load AS weekly_load,
        monotony.daily_mean_load AS daily_mean_load,
        monotony.daily_load_standard_deviation AS daily_load_standard_deviation
      FROM monotony
      WHERE monotony.user_id = {userId:UUID}
        AND monotony.is_deleted = 0
        ${rangeFilter}
      ORDER BY monotony.week`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...rangeDaysParams(days),
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
          dailyMeanLoad: row.daily_mean_load,
          dailyLoadStandardDeviation: row.daily_load_standard_deviation,
        }),
    );
  }

  /** Estimate FTP as 95% of best 20-minute average power. */
  async getEstimatedFtp(days: RangeDays): Promise<number | null> {
    const rangeFilter = clickHouseIntervalDayLowerBound(days, "asum.started_at");
    const ftpResult = await this.#sensorStore.query(
      ftpSchema,
      `SELECT
        round(max(asum.best_twenty_minute_power) * 0.95, 1) AS ftp
      FROM analytics.activity_summary asum
      WHERE asum.user_id = {userId:UUID}
        AND has({activityTypes:Array(String)}, asum.canonical_type)
        ${rangeFilter}
        AND asum.best_twenty_minute_power IS NOT NULL`,
      {
        userId: this.#userId,
        ...rangeDaysParams(days),
        activityTypes: CYCLING_TYPES,
      },
    );
    return ftpResult[0]?.ftp ?? null;
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

    const ftp = await this.getEstimatedFtp(days);
    if (!ftp) return { models: [], totalCount: 0, emptyReason: "no_ftp_estimate" };

    const rangeFilter = clickHouseIntervalDayLowerBound(days, "asum.started_at");
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
        AND has({activityTypes:Array(String)}, asum.canonical_type)
        ${rangeFilter}
        AND asum.normalized_power IS NOT NULL
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
        `SELECT count() AS total
        FROM analytics.activity_summary asum
        WHERE asum.user_id = {userId:UUID}
          AND has({activityTypes:Array(String)}, asum.canonical_type)
          ${rangeFilter}
          AND asum.normalized_power IS NOT NULL`,
        {
          userId: this.#userId,
          ...rangeDaysParams(days),
          activityTypes: CYCLING_TYPES,
        },
      );
      totalCount = countRows[0]?.total ?? 0;
      emptyReason = totalCount === 0 ? "no_normalized_power" : null;
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
            ftp,
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
            date: row.date,
            activityName: row.name,
            activityType: row.canonical_type,
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
