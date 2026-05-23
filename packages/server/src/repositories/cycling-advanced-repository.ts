import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import type { Database } from "dofek/db";
import { z } from "zod";
import { dateWindowStartString } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  ActivityVariabilityModel,
  PedalDynamicsModel,
  type RampRateResultData,
  RampRateWeekModel,
  TrainingMonotonyWeekModel,
  VerticalAscentModel,
} from "./cycling-advanced-models.ts";
import { restingHeartRateClickHouseCte } from "./resting-heart-rate-query.ts";

const ENDURANCE_TYPES: string[] = [...ENDURANCE_ACTIVITY_TYPES];

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const dailyLoadSchema = z.object({
  day: dateStringSchema,
  trimp: z.coerce.number(),
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
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore: ActivitySensorStore;

  constructor(
    _db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorStore,
  ) {
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
  }

  /** Ramp rate: week-over-week CTL change based on HR TRIMP load. */
  async getRampRate(days: number): Promise<RampRateResultData> {
    const today = new Date().toISOString().slice(0, 10);
    const dailyLoads = await this.#sensorStore.query(
      dailyLoadSchema,
      `WITH ${restingHeartRateClickHouseCte()},
      activity_meta AS (
        SELECT
          asum.activity_id AS id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at,
          asum.avg_hr AS avg_hr,
          toDate(toTimeZone(asum.started_at, {timezone:String})) AS day,
          up.max_hr AS max_hr,
          coalesce(up.resting_hr, drhr.resting_hr, 60) AS resting_hr_val
        FROM analytics.activity_summary asum
        INNER JOIN postgres_fitness.user_profile_current up ON up.id = asum.user_id
        LEFT JOIN resting_heart_rate drhr
          ON drhr.date = toString(toDate(toTimeZone(asum.started_at, {timezone:String})))
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, asum.activity_type)
          AND asum.started_at > now() - INTERVAL ({days:Int32} + 42) DAY
          AND asum.ended_at IS NOT NULL
          AND asum.avg_hr IS NOT NULL
          AND asum.avg_hr > 0
          AND up.max_hr IS NOT NULL
      )
      SELECT
        toString(day) AS day,
        sum(if(max_hr > resting_hr_val AND avg_hr > resting_hr_val,
          dateDiff('second', started_at, ended_at) / 60.0
          * (toFloat64(avg_hr - resting_hr_val) / toFloat64(max_hr - resting_hr_val))
          * 0.64 * exp(1.92 * (toFloat64(avg_hr - resting_hr_val) / toFloat64(max_hr - resting_hr_val)))
          / (60.0 * 0.85 * 0.64 * exp(1.92 * 0.85))
          * 100,
          0)) AS trimp
      FROM activity_meta
      GROUP BY day
      ORDER BY day`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
        enduranceTypes: ENDURANCE_TYPES,
        rhrEndDate: today,
        rhrWindowStart: dateWindowStartString(today, days + 42),
      },
    );

    if (dailyLoads.length === 0)
      return { weeks: [], currentRampRate: 0, recommendation: "No data" };

    // Fill in zero-load days and compute CTL (42-day EWMA)
    const loadMap = new Map<string, number>();
    for (const row of dailyLoads) {
      loadMap.set(row.day, row.trimp);
    }

    const firstLoad = dailyLoads[0];
    const lastLoad = dailyLoads[dailyLoads.length - 1];
    if (!firstLoad || !lastLoad)
      return { weeks: [], currentRampRate: 0, recommendation: "No data" };
    const startDate = new Date(firstLoad.day);
    const endDate = new Date(lastLoad.day);
    const ctlByDate = new Map<string, number>();
    let ctl = 0;

    for (
      let current = new Date(startDate);
      current <= endDate;
      current.setDate(current.getDate() + 1)
    ) {
      const key = current.toISOString().slice(0, 10);
      const load = loadMap.get(key) ?? 0;
      ctl = ctl + (load - ctl) / 42;
      ctlByDate.set(key, ctl);
    }

    // Group into weeks and compute ramp rate
    const ctlEntries = [...ctlByDate.entries()].sort(([dateA], [dateB]) =>
      dateA.localeCompare(dateB),
    );

    // Filter to only the requested date range (exclude the 42-day warmup)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);
    const filtered = ctlEntries.filter(([dateStr]) => dateStr >= cutoffStr);

    // Group by ISO week
    const weekMap = new Map<string, { first: number; last: number }>();
    for (const [dateStr, ctlValue] of filtered) {
      const dateObj = new Date(dateStr);
      const dayOfWeek = dateObj.getDay();
      const monday = new Date(dateObj);
      monday.setDate(dateObj.getDate() - ((dayOfWeek + 6) % 7));
      const weekKey = monday.toISOString().slice(0, 10);

      const existing = weekMap.get(weekKey);
      if (!existing) {
        weekMap.set(weekKey, { first: ctlValue, last: ctlValue });
      } else {
        existing.last = ctlValue;
      }
    }

    const weeks: RampRateWeekModel[] = [];
    const weekKeys = [...weekMap.keys()].sort();
    for (let idx = 1; idx < weekKeys.length; idx++) {
      const prevKey = weekKeys[idx - 1];
      const currKey = weekKeys[idx];
      if (!prevKey || !currKey) continue;
      const prevWeek = weekMap.get(prevKey);
      const currWeek = weekMap.get(currKey);
      if (!prevWeek || !currWeek) continue;

      const rampRate = Math.round((currWeek.last - prevWeek.last) * 100) / 100;
      weeks.push(
        new RampRateWeekModel({
          week: currKey,
          ctlStart: Math.round(prevWeek.last * 100) / 100,
          ctlEnd: Math.round(currWeek.last * 100) / 100,
          rampRate,
        }),
      );
    }

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
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.#sensorStore.query(
      monotonyRowSchema,
      `WITH ${restingHeartRateClickHouseCte()},
      activity_meta AS (
        SELECT
          asum.activity_id AS id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at,
          asum.avg_hr AS avg_hr,
          toDate(toTimeZone(asum.started_at, {timezone:String})) AS day,
          up.max_hr AS max_hr,
          coalesce(up.resting_hr, drhr.resting_hr, 60) AS resting_hr_val
        FROM analytics.activity_summary asum
        INNER JOIN postgres_fitness.user_profile_current up ON up.id = asum.user_id
        LEFT JOIN resting_heart_rate drhr
          ON drhr.date = toString(toDate(toTimeZone(asum.started_at, {timezone:String})))
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, asum.activity_type)
          AND asum.started_at > now() - INTERVAL {days:Int32} DAY
          AND asum.ended_at IS NOT NULL
          AND asum.avg_hr IS NOT NULL
          AND asum.avg_hr > 0
          AND up.max_hr IS NOT NULL
      ),
      daily_loads AS (
        SELECT
          day,
          sum(if(max_hr > resting_hr_val AND avg_hr > resting_hr_val,
            dateDiff('second', started_at, ended_at) / 60.0
            * (toFloat64(avg_hr - resting_hr_val) / toFloat64(max_hr - resting_hr_val))
            * 0.64 * exp(1.92 * (toFloat64(avg_hr - resting_hr_val) / toFloat64(max_hr - resting_hr_val)))
            / (60.0 * 0.85 * 0.64 * exp(1.92 * 0.85))
            * 100,
            0)) AS trimp
        FROM activity_meta
        GROUP BY day
      ),
      weekly_stats AS (
        SELECT
          toMonday(day) AS week,
          avg(trimp) AS mean_load,
          stddevPop(trimp) AS stdev_load,
          sum(trimp) AS weekly_load
        FROM daily_loads
        GROUP BY toMonday(day)
        HAVING stddevPop(trimp) > 0
      )
      SELECT
        toString(week) AS week,
        round(mean_load / stdev_load, 2) AS monotony,
        round(weekly_load * (mean_load / stdev_load), 1) AS strain,
        round(weekly_load, 1) AS weekly_load
      FROM weekly_stats
      ORDER BY week`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
        enduranceTypes: ENDURANCE_TYPES,
        rhrEndDate: today,
        rhrWindowStart: dateWindowStartString(today, days),
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
      `WITH activity_power AS (
        SELECT
          a.activity_id AS activity_id,
          ds.recorded_at AS recorded_at,
          row_number() OVER (
            PARTITION BY a.activity_id ORDER BY ds.recorded_at
          ) AS rn,
          sum(coalesce(ds.scalar, 0)) OVER (
            PARTITION BY a.activity_id ORDER BY ds.recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS cumsum
        FROM analytics.deduped_sensor ds
        INNER JOIN analytics.activity_summary a
          ON a.user_id = ds.user_id
         AND ds.recorded_at >= a.started_at
         AND ds.recorded_at <= coalesce(a.ended_at, a.started_at + INTERVAL 12 HOUR)
        WHERE ds.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND a.started_at > now() - INTERVAL {days:Int32} DAY
          AND ds.channel = 'power'
          AND ds.is_deleted = 0
      ),
      sample_rate AS (
        SELECT
          activity_id,
          greatest(toInt32(round(
            dateDiff('second', min(recorded_at), max(recorded_at))
            / nullIf(count() - 1, 0)
          )), 1) AS interval_s
        FROM activity_power
        GROUP BY activity_id
        HAVING count() > 1
      )
      SELECT
        round(max(toFloat64(ap.cumsum - prev.cumsum) / round(1200.0 / sr.interval_s)) * 0.95, 1) AS ftp
      FROM activity_power ap
      INNER JOIN sample_rate sr ON sr.activity_id = ap.activity_id
      INNER JOIN activity_power prev
        ON prev.activity_id = ap.activity_id
       AND toInt64(prev.rn) = toInt64(ap.rn) - toInt64(round(1200.0 / sr.interval_s))
      WHERE toInt64(ap.rn) >= toInt64(round(1200.0 / sr.interval_s))`,
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
    const ftp = await this.getEstimatedFtp(days);
    if (!ftp) return { models: [], totalCount: 0 };

    const rows = await this.#sensorStore.query(
      variabilityRowSchema,
      `WITH rolling AS (
        SELECT
          a.activity_id AS activity_id,
          avg(ds.scalar) OVER (
            PARTITION BY a.activity_id
            ORDER BY toUnixTimestamp(ds.recorded_at)
            RANGE BETWEEN 29 PRECEDING AND CURRENT ROW
          ) AS rolling_30s_power
        FROM analytics.deduped_sensor ds
        INNER JOIN analytics.activity_summary a
          ON a.user_id = ds.user_id
         AND ds.recorded_at >= a.started_at
         AND ds.recorded_at <= coalesce(a.ended_at, a.started_at + INTERVAL 12 HOUR)
        WHERE ds.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND a.started_at > now() - INTERVAL {days:Int32} DAY
          AND ds.channel = 'power'
          AND ds.scalar > 0
          AND ds.is_deleted = 0
      ),
      grouped AS (
        SELECT
          toString(a.activity_id) AS activity_id,
          toString(toDate(toTimeZone(a.started_at, {timezone:String}))) AS date,
          a.name AS name,
          a.started_at AS started_at,
          round(pow(avg(pow(r.rolling_30s_power, 4)), 0.25), 1) AS np,
          round(avg(r.rolling_30s_power), 1) AS avg_power
        FROM rolling r
        INNER JOIN analytics.activity_summary a ON a.activity_id = r.activity_id
        GROUP BY a.activity_id, a.started_at, a.name
        HAVING count() >= 60
      )
      SELECT
        activity_id, date, name, np, avg_power,
        toInt32(count() OVER ()) AS total_count
      FROM grouped
      ORDER BY started_at DESC
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
    const rows = await this.#sensorStore.query(
      vamRowSchema,
      `WITH altitude_points AS (
        SELECT
          a.activity_id AS activity_id,
          alt.scalar AS altitude,
          alt.recorded_at AS recorded_at,
          lagInFrame(alt.scalar) OVER (
            PARTITION BY a.activity_id ORDER BY alt.recorded_at
          ) AS prev_altitude,
          lagInFrame(alt.recorded_at) OVER (
            PARTITION BY a.activity_id ORDER BY alt.recorded_at
          ) AS prev_recorded_at
        FROM analytics.deduped_sensor alt
        INNER JOIN analytics.activity_summary a
          ON a.user_id = alt.user_id
         AND alt.recorded_at >= a.started_at
         AND alt.recorded_at <= coalesce(a.ended_at, a.started_at + INTERVAL 12 HOUR)
        WHERE a.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND a.started_at > now() - INTERVAL {days:Int32} DAY
          AND alt.channel = 'altitude'
          AND alt.is_deleted = 0
      ),
      grade_activities AS (
        SELECT DISTINCT
          a.activity_id AS activity_id,
          1 AS has_grade_samples
        FROM analytics.deduped_sensor grd
        INNER JOIN analytics.activity_summary a
          ON a.user_id = grd.user_id
         AND grd.recorded_at >= a.started_at
         AND grd.recorded_at <= coalesce(a.ended_at, a.started_at + INTERVAL 12 HOUR)
        WHERE a.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND a.started_at > now() - INTERVAL {days:Int32} DAY
          AND grd.channel = 'grade'
          AND grd.is_deleted = 0
      ),
      grade_points AS (
        SELECT
          a.activity_id AS activity_id,
          grd.recorded_at AS recorded_at,
          grd.scalar AS grade
        FROM analytics.deduped_sensor grd
        INNER JOIN analytics.activity_summary a
          ON a.user_id = grd.user_id
         AND grd.recorded_at >= a.started_at
         AND grd.recorded_at <= coalesce(a.ended_at, a.started_at + INTERVAL 12 HOUR)
        WHERE a.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND a.started_at > now() - INTERVAL {days:Int32} DAY
          AND grd.channel = 'grade'
          AND grd.is_deleted = 0
      ),
      climbing_segments AS (
        SELECT
          ap.activity_id AS activity_id,
          ap.recorded_at AS recorded_at,
          ap.altitude AS altitude,
          ap.prev_altitude AS prev_altitude,
          ap.prev_recorded_at AS prev_recorded_at,
          gp.grade AS grade,
          coalesce(ga.has_grade_samples, 0) = 1 AS has_grade_samples,
          row_number() OVER (
            PARTITION BY ap.activity_id, ap.recorded_at
            ORDER BY
              if(gp.recorded_at IS NULL, 1, 0) ASC,
              abs(dateDiff('second', gp.recorded_at, ap.recorded_at)) ASC,
              gp.recorded_at ASC
          ) AS grade_rank
        FROM altitude_points ap
        LEFT JOIN grade_activities ga ON ga.activity_id = ap.activity_id
        LEFT JOIN grade_points gp
          ON gp.activity_id = ap.activity_id
         AND gp.recorded_at BETWEEN ap.recorded_at - INTERVAL 5 SECOND
                                AND ap.recorded_at + INTERVAL 5 SECOND
      )
      SELECT
        toString(toDate(toTimeZone(a.started_at, {timezone:String}))) AS date,
        a.name AS name,
        round(sum(cs.altitude - cs.prev_altitude), 1) AS elevation_gain,
        toInt32(sum(dateDiff('second', cs.prev_recorded_at, cs.recorded_at))) AS climbing_seconds
      FROM climbing_segments cs
      INNER JOIN analytics.activity_summary a ON a.activity_id = cs.activity_id
      WHERE cs.prev_altitude IS NOT NULL
        AND cs.prev_recorded_at IS NOT NULL
        AND cs.altitude > cs.prev_altitude
        AND cs.grade_rank = 1
        AND (NOT coalesce(cs.has_grade_samples, false) OR cs.grade > 3)
      GROUP BY a.activity_id, a.started_at, a.name
      HAVING sum(dateDiff('second', cs.prev_recorded_at, cs.recorded_at)) > 60
      ORDER BY a.started_at`,
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
}
