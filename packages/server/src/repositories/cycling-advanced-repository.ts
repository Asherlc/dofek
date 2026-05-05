import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import type { Database } from "dofek/db";
import { z } from "zod";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const ENDURANCE_TYPES = [...ENDURANCE_ACTIVITY_TYPES] as string[];

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface RampRateWeekRow {
  week: string;
  ctlStart: number;
  ctlEnd: number;
  rampRate: number;
}

/** A single week in the ramp rate timeline. */
export class RampRateWeekModel {
  readonly #row: RampRateWeekRow;

  constructor(row: RampRateWeekRow) {
    this.#row = row;
  }

  get week(): string {
    return this.#row.week;
  }

  get ctlStart(): number {
    return this.#row.ctlStart;
  }

  get ctlEnd(): number {
    return this.#row.ctlEnd;
  }

  get rampRate(): number {
    return this.#row.rampRate;
  }

  toDetail() {
    return {
      week: this.#row.week,
      ctlStart: this.#row.ctlStart,
      ctlEnd: this.#row.ctlEnd,
      rampRate: this.#row.rampRate,
    };
  }
}

export interface RampRateResultData {
  weeks: RampRateWeekModel[];
  currentRampRate: number;
  recommendation: string;
}

export interface TrainingMonotonyWeekRow {
  week: string;
  monotony: number;
  strain: number;
  weeklyLoad: number;
}

/** Weekly training monotony and strain. */
export class TrainingMonotonyWeekModel {
  readonly #row: TrainingMonotonyWeekRow;

  constructor(row: TrainingMonotonyWeekRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      week: this.#row.week,
      monotony: this.#row.monotony,
      strain: this.#row.strain,
      weeklyLoad: this.#row.weeklyLoad,
    };
  }
}

export interface ActivityVariabilityRowData {
  activityId: string;
  date: string;
  activityName: string;
  normalizedPower: number;
  averagePower: number;
}

/** A single activity with variability and intensity factor metrics. */
export class ActivityVariabilityModel {
  readonly #row: ActivityVariabilityRowData;
  readonly #ftp: number;

  constructor(row: ActivityVariabilityRowData, ftp: number) {
    this.#row = row;
    this.#ftp = ftp;
  }

  get date(): string {
    return this.#row.date;
  }

  get activityId(): string {
    return this.#row.activityId;
  }

  get activityName(): string {
    return this.#row.activityName;
  }

  get normalizedPower(): number {
    return this.#row.normalizedPower;
  }

  get averagePower(): number {
    return this.#row.averagePower;
  }

  get variabilityIndex(): number {
    return Math.round((this.#row.normalizedPower / this.#row.averagePower) * 1000) / 1000;
  }

  get intensityFactor(): number {
    return Math.round((this.#row.normalizedPower / this.#ftp) * 1000) / 1000;
  }

  toDetail() {
    return {
      activityId: this.activityId,
      date: this.date,
      activityName: this.activityName,
      normalizedPower: this.normalizedPower,
      averagePower: this.averagePower,
      variabilityIndex: this.variabilityIndex,
      intensityFactor: this.intensityFactor,
    };
  }
}

export interface VerticalAscentRowData {
  date: string;
  activityName: string;
  elevationGainMeters: number;
  climbingSeconds: number;
}

/** An activity with vertical ascent rate (VAM) for climbing segments. */
export class VerticalAscentModel {
  readonly #row: VerticalAscentRowData;

  constructor(row: VerticalAscentRowData) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get activityName(): string {
    return this.#row.activityName;
  }

  get elevationGainMeters(): number {
    return this.#row.elevationGainMeters;
  }

  get climbingMinutes(): number {
    return Math.round((this.#row.climbingSeconds / 60) * 10) / 10;
  }

  get verticalAscentRate(): number {
    return this.#row.climbingSeconds > 0
      ? Math.round((this.#row.elevationGainMeters / (this.#row.climbingSeconds / 3600)) * 10) / 10
      : 0;
  }

  toDetail() {
    return {
      date: this.date,
      activityName: this.activityName,
      verticalAscentRate: this.verticalAscentRate,
      elevationGainMeters: this.elevationGainMeters,
      climbingMinutes: this.climbingMinutes,
    };
  }
}

export interface PedalDynamicsRowData {
  date: string;
  activityName: string;
  leftRightBalance: number;
  avgTorqueEffectiveness: number;
  avgPedalSmoothness: number;
}

/** An activity with pedal dynamics metrics. */
export class PedalDynamicsModel {
  readonly #row: PedalDynamicsRowData;

  constructor(row: PedalDynamicsRowData) {
    this.#row = row;
  }

  toDetail() {
    return {
      date: this.#row.date,
      activityName: this.#row.activityName,
      leftRightBalance: this.#row.leftRightBalance,
      avgTorqueEffectiveness: this.#row.avgTorqueEffectiveness,
      avgPedalSmoothness: this.#row.avgPedalSmoothness,
    };
  }
}

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
    const dailyLoads = await this.#sensorStore.query(
      dailyLoadSchema,
      `WITH activity_meta AS (
        SELECT
          asum.activity_id AS id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at,
          asum.avg_hr AS avg_hr,
          toDate(toTimeZone(asum.started_at, {timezone:String})) AS day,
          up.max_hr AS max_hr,
          coalesce(up.resting_hr, drhr.resting_hr, 60) AS resting_hr_val
        FROM analytics.activity_summary asum
        INNER JOIN postgres_fitness_live.user_profile up ON up.id = asum.user_id
        LEFT JOIN postgres_fitness_live.derived_resting_heart_rate drhr
          ON drhr.user_id = asum.user_id
         AND drhr.date = toDate(toTimeZone(asum.started_at, {timezone:String}))
        INNER JOIN postgres_fitness_live.v_activity a ON a.id = asum.activity_id
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
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
    const rows = await this.#sensorStore.query(
      monotonyRowSchema,
      `WITH activity_meta AS (
        SELECT
          asum.activity_id AS id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at,
          asum.avg_hr AS avg_hr,
          toDate(toTimeZone(asum.started_at, {timezone:String})) AS day,
          up.max_hr AS max_hr,
          coalesce(up.resting_hr, drhr.resting_hr, 60) AS resting_hr_val
        FROM analytics.activity_summary asum
        INNER JOIN postgres_fitness_live.user_profile up ON up.id = asum.user_id
        LEFT JOIN postgres_fitness_live.derived_resting_heart_rate drhr
          ON drhr.user_id = asum.user_id
         AND drhr.date = toDate(toTimeZone(asum.started_at, {timezone:String}))
        INNER JOIN postgres_fitness_live.v_activity a ON a.id = asum.activity_id
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
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
          ds.activity_id AS activity_id,
          ds.recorded_at AS recorded_at,
          row_number() OVER (
            PARTITION BY ds.activity_id ORDER BY ds.recorded_at
          ) AS rn,
          sum(coalesce(ds.scalar, 0)) OVER (
            PARTITION BY ds.activity_id ORDER BY ds.recorded_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS cumsum
        FROM analytics.deduped_sensor ds
        INNER JOIN postgres_fitness_live.v_activity a ON a.id = ds.activity_id
        WHERE ds.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND a.started_at > now() - INTERVAL {days:Int32} DAY
          AND ds.channel = 'power'
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
       AND prev.rn = ap.rn - toInt32(round(1200.0 / sr.interval_s))
      WHERE ap.rn >= toInt32(round(1200.0 / sr.interval_s))`,
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
          ds.activity_id AS activity_id,
          avg(ds.scalar) OVER (
            PARTITION BY ds.activity_id
            ORDER BY ds.recorded_at
            RANGE BETWEEN 29 PRECEDING AND CURRENT ROW
          ) AS rolling_30s_power
        FROM analytics.deduped_sensor ds
        INNER JOIN postgres_fitness_live.v_activity a ON a.id = ds.activity_id
        WHERE ds.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND a.started_at > now() - INTERVAL {days:Int32} DAY
          AND ds.channel = 'power'
          AND ds.scalar > 0
      ),
      grouped AS (
        SELECT
          toString(a.id) AS activity_id,
          toString(toDate(toTimeZone(a.started_at, {timezone:String}))) AS date,
          a.name AS name,
          a.started_at AS started_at,
          round(pow(avg(pow(r.rolling_30s_power, 4)), 0.25), 1) AS np,
          round(avg(r.rolling_30s_power), 1) AS avg_power
        FROM rolling r
        INNER JOIN postgres_fitness_live.v_activity a ON a.id = r.activity_id
        GROUP BY a.id, a.started_at, a.name
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
          alt.activity_id AS activity_id,
          alt.scalar AS altitude,
          alt.recorded_at AS recorded_at,
          lagInFrame(alt.scalar) OVER (
            PARTITION BY alt.activity_id ORDER BY alt.recorded_at
          ) AS prev_altitude,
          lagInFrame(alt.recorded_at) OVER (
            PARTITION BY alt.activity_id ORDER BY alt.recorded_at
          ) AS prev_recorded_at
        FROM analytics.deduped_sensor alt
        INNER JOIN postgres_fitness_live.v_activity a ON a.id = alt.activity_id
        WHERE a.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND a.started_at > now() - INTERVAL {days:Int32} DAY
          AND alt.channel = 'altitude'
      ),
      grade_activities AS (
        SELECT DISTINCT grd.activity_id AS activity_id
        FROM analytics.deduped_sensor grd
        INNER JOIN postgres_fitness_live.v_activity a ON a.id = grd.activity_id
        WHERE a.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND a.started_at > now() - INTERVAL {days:Int32} DAY
          AND grd.channel = 'grade'
      ),
      grade_points AS (
        SELECT
          grd.activity_id AS activity_id,
          grd.recorded_at AS recorded_at,
          grd.scalar AS grade
        FROM analytics.deduped_sensor grd
        INNER JOIN postgres_fitness_live.v_activity a ON a.id = grd.activity_id
        WHERE a.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND a.started_at > now() - INTERVAL {days:Int32} DAY
          AND grd.channel = 'grade'
      ),
      climbing_segments AS (
        SELECT
          ap.activity_id AS activity_id,
          ap.recorded_at AS recorded_at,
          ap.altitude AS altitude,
          ap.prev_altitude AS prev_altitude,
          ap.prev_recorded_at AS prev_recorded_at,
          (
            SELECT gp.grade FROM grade_points gp
            WHERE gp.activity_id = ap.activity_id
              AND gp.recorded_at BETWEEN ap.recorded_at - INTERVAL 5 SECOND
                                     AND ap.recorded_at + INTERVAL 5 SECOND
            ORDER BY abs(dateDiff('second', gp.recorded_at, ap.recorded_at)) ASC,
                     gp.recorded_at ASC
            LIMIT 1
          ) AS grade,
          ga.activity_id IS NOT NULL AS has_grade_samples
        FROM altitude_points ap
        LEFT JOIN grade_activities ga ON ga.activity_id = ap.activity_id
      )
      SELECT
        toString(toDate(toTimeZone(a.started_at, {timezone:String}))) AS date,
        a.name AS name,
        round(sum(cs.altitude - cs.prev_altitude), 1) AS elevation_gain,
        toInt32(sum(dateDiff('second', cs.prev_recorded_at, cs.recorded_at))) AS climbing_seconds
      FROM climbing_segments cs
      INNER JOIN postgres_fitness_live.v_activity a ON a.id = cs.activity_id
      WHERE cs.prev_altitude IS NOT NULL
        AND cs.prev_recorded_at IS NOT NULL
        AND cs.altitude > cs.prev_altitude
        AND (NOT cs.has_grade_samples OR cs.grade > 3)
      GROUP BY a.id, a.started_at, a.name
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
      INNER JOIN postgres_fitness_live.v_activity a ON a.id = asum.activity_id
      WHERE asum.user_id = {userId:UUID}
        AND has({enduranceTypes:Array(String)}, a.activity_type)
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
