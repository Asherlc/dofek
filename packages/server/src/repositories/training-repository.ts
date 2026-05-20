import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import { HEART_RATE_ZONES } from "@dofek/zones/zones";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import {
  dateWindowStartString,
  timestampWindowStart,
  timestampWindowStartString,
} from "../lib/date-window.ts";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  heartRateZoneCountColumns,
  heartRateZoneSqlParams,
  heartRateZoneSumColumns,
} from "./heart-rate-zone-sql.ts";
import {
  fetchRestingHeartRateRows,
  restingHeartRateClickHouseCte,
  restingHeartRateValuesCte,
} from "./resting-heart-rate-query.ts";
import {
  buildNextWorkoutRecommendation,
  type NextWorkoutRecommendation,
} from "./training-recommendation.ts";

const ENDURANCE_TYPES: string[] = [...ENDURANCE_ACTIVITY_TYPES];

const activityMetaHeartRateExpressions = {
  maxHr: "am.max_hr",
  restingHr: "am.resting_hr",
};

function requireHeartRateZone(zoneNumber: number) {
  const zone = HEART_RATE_ZONES.find((zoneDefinition) => zoneDefinition.zone === zoneNumber);
  if (!zone) {
    throw new Error(`Heart-rate zone ${zoneNumber} definition is required`);
  }
  return zone;
}

const highIntensityZone = requireHeartRateZone(4);

// ---------------------------------------------------------------------------
// Zod schemas for DB rows
// ---------------------------------------------------------------------------

const weeklyVolumeRowSchema = z.object({
  week: dateStringSchema,
  activity_type: z.string(),
  count: z.number(),
  hours: z.coerce.number(),
});

export type WeeklyVolumeRow = z.infer<typeof weeklyVolumeRowSchema>;

const hrZoneRowSchema = z.object({
  max_hr: z.number().nullable(),
  week: dateStringSchema,
  zone0: z.coerce.number(),
  zone1: z.coerce.number(),
  zone2: z.coerce.number(),
  zone3: z.coerce.number(),
  zone4: z.coerce.number(),
  zone5: z.coerce.number(),
});

export type HrZoneRow = z.infer<typeof hrZoneRowSchema>;

const activityStatsRowSchema = z.object({
  id: z.string(),
  activity_type: z.string(),
  name: z.string().nullable(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  avg_hr: z.coerce.number().nullable(),
  max_hr: z.coerce.number().nullable(),
  avg_power: z.coerce.number().nullable(),
  max_power: z.coerce.number().nullable(),
  avg_cadence: z.coerce.number().nullable(),
  hr_samples: z.coerce.number().nullable(),
  power_samples: z.coerce.number().nullable(),
  distance_meters: z.coerce.number().nullable(),
});

export type ActivityStatsRow = z.infer<typeof activityStatsRowSchema>;

const readinessMetricSchema = z.object({
  date: dateStringSchema,
  hrv: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  respiratory_rate: z.coerce.number().nullable(),
  hrv_mean_30d: z.coerce.number().nullable(),
  hrv_sd_30d: z.coerce.number().nullable(),
  rhr_mean_30d: z.coerce.number().nullable(),
  rhr_sd_30d: z.coerce.number().nullable(),
  rr_mean_30d: z.coerce.number().nullable(),
  rr_sd_30d: z.coerce.number().nullable(),
});

export type ReadinessMetricRow = z.infer<typeof readinessMetricSchema>;

const sleepRowSchema = z.object({
  efficiency_pct: z.coerce.number().nullable(),
});

const acwrRowSchema = z.object({
  acwr: z.coerce.number().nullable(),
});

const muscleFreshnessSchema = z.object({
  muscle_group: z.string(),
  last_trained_date: dateStringSchema,
});

export type MuscleFreshnessRow = z.infer<typeof muscleFreshnessSchema>;

const balanceSchema = z.object({
  strength_7d: z.coerce.number(),
  endurance_7d: z.coerce.number(),
  last_strength_date: dateStringSchema.nullable(),
  last_endurance_date: dateStringSchema.nullable(),
});

export type BalanceRow = z.infer<typeof balanceSchema>;

const zoneTotalsSchema = z.object({
  zone0: z.coerce.number(),
  zone1: z.coerce.number(),
  zone2: z.coerce.number(),
  zone3: z.coerce.number(),
  zone4: z.coerce.number(),
  zone5: z.coerce.number(),
});

export type ZoneTotalsRow = z.infer<typeof zoneTotalsSchema>;

const hiitLoadSchema = z.object({
  hiit_count_7d: z.coerce.number(),
  last_hiit_date: dateStringSchema.nullable(),
});

export type HiitLoadRow = z.infer<typeof hiitLoadSchema>;

const trainingDaySchema = z.object({
  training_date: dateStringSchema,
});

// ---------------------------------------------------------------------------
// Data bundle returned by getNextWorkoutData
// ---------------------------------------------------------------------------

export interface NextWorkoutData {
  latestMetric: ReadinessMetricRow | null;
  latestSleepEfficiency: number | null;
  acwr: number | null;
  muscleFreshness: MuscleFreshnessRow[];
  balance: BalanceRow;
  zoneTotals: ZoneTotalsRow;
  hiitLoad: HiitLoadRow;
  trainingDates: string[];
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class TrainingRepository extends BaseRepository {
  readonly #sensorStore: ActivitySensorStore;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorStore,
    accessWindow?: AccessWindow,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#sensorStore = sensorStore;
  }

  /** Weekly training volume grouped by activity type. */
  async getWeeklyVolume(days: number): Promise<WeeklyVolumeRow[]> {
    const accessWindowPredicate =
      this.accessWindow.kind === "full"
        ? ""
        : `AND started_at >= toDateTime({accessStart:String})
          AND started_at < toDateTime({accessEnd:String})`;
    const accessWindowParams =
      this.accessWindow.kind === "full"
        ? {}
        : {
            accessStart: this.accessWindow.startDate,
            accessEnd: this.accessWindow.endDateExclusive,
          };

    return this.#sensorStore.query(
      weeklyVolumeRowSchema,
      `SELECT
        toString(toMonday(toDate(toTimeZone(started_at, {timezone:String})))) AS week,
        activity_type,
        toInt32(count()) AS count,
        round(sum(dateDiff('second', started_at, ended_at)) / 3600, 2) AS hours
      FROM analytics.v_activity
      WHERE user_id = {userId:UUID}
        AND started_at > now() - INTERVAL {days:Int32} DAY
        AND ended_at IS NOT NULL
        ${accessWindowPredicate}
      GROUP BY week, activity_type
      ORDER BY week`,
      {
        userId: this.userId,
        timezone: this.timezone,
        days,
        ...accessWindowParams,
      },
    );
  }

  /** HR zone distribution per week using the canonical Karvonen model. */
  async getHrZones(days: number): Promise<{ maxHr: number | null; weeks: HrZoneRow[] }> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.#sensorStore.query(
      hrZoneRowSchema,
      `WITH ${restingHeartRateClickHouseCte()},
      activity_meta AS (
        SELECT
          asum.activity_id AS id,
          toDate(toTimeZone(asum.started_at, {timezone:String})) AS activity_date,
          up.max_hr AS max_hr,
          coalesce(drhr.resting_hr, up.resting_hr, 60) AS resting_hr
        FROM analytics.activity_summary asum
        INNER JOIN analytics.v_activity a ON a.id = asum.activity_id
        INNER JOIN postgres_fitness.user_profile_current up ON up.id = asum.user_id
        LEFT JOIN resting_heart_rate drhr
          ON drhr.date = toString(toDate(asum.started_at))
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND asum.started_at > now() - INTERVAL {days:Int32} DAY
          AND up.max_hr IS NOT NULL
      ),
      zone_counts AS (
        SELECT
          am.activity_date AS activity_date,
          am.max_hr AS max_hr,
          ${heartRateZoneCountColumns("ds.scalar", activityMetaHeartRateExpressions)}
        FROM analytics.deduped_sensor ds
        INNER JOIN activity_meta am ON am.id = ds.activity_id
        WHERE ds.channel = 'heart_rate' AND ds.scalar IS NOT NULL
        GROUP BY am.activity_date, am.max_hr
      )
      SELECT
        toString(toMonday(activity_date)) AS week,
        max(max_hr) AS max_hr,
        ${heartRateZoneSumColumns()}
      FROM zone_counts
      GROUP BY toMonday(activity_date)
      ORDER BY week`,
      {
        userId: this.userId,
        timezone: this.timezone,
        days,
        rhrWindowStart: dateWindowStartString(today, days),
        rhrEndDate: today,
        enduranceTypes: ENDURANCE_TYPES,
        ...heartRateZoneSqlParams(),
      },
    );
    const rawMaxHr = rows[0]?.max_hr;
    const maxHr = typeof rawMaxHr === "number" ? rawMaxHr : null;
    if (!maxHr) return { maxHr: null, weeks: [] };
    return { maxHr, weeks: rows };
  }

  /** Per-activity summary with HR and power stats. */
  async getActivityStats(days: number): Promise<ActivityStatsRow[]> {
    return this.#sensorStore.query(
      activityStatsRowSchema,
      `WITH sample_counts AS (
        SELECT
          activity_id,
          countIf(channel = 'heart_rate') AS hr_samples,
          countIf(channel = 'power') AS power_samples
        FROM analytics.deduped_sensor
        WHERE user_id = {userId:UUID}
        GROUP BY activity_id
      )
      SELECT
        toString(a.id) AS id,
        a.activity_type AS activity_type,
        a.name AS name,
        formatDateTime(a.started_at, '%Y-%m-%dT%H:%i:%SZ') AS started_at,
        formatDateTime(a.ended_at, '%Y-%m-%dT%H:%i:%SZ') AS ended_at,
        round(asum.avg_hr, 1) AS avg_hr,
        asum.max_hr AS max_hr,
        round(asum.avg_power, 1) AS avg_power,
        asum.max_power AS max_power,
        round(asum.avg_cadence, 1) AS avg_cadence,
        coalesce(sc.hr_samples, 0) AS hr_samples,
        coalesce(sc.power_samples, 0) AS power_samples,
        asum.total_distance AS distance_meters
      FROM analytics.v_activity a
      LEFT JOIN analytics.activity_summary asum ON asum.activity_id = a.id
      LEFT JOIN sample_counts sc ON sc.activity_id = a.id
      WHERE a.user_id = {userId:UUID}
        AND a.started_at > now() - INTERVAL {days:Int32} DAY
      ORDER BY a.started_at DESC`,
      { userId: this.userId, days },
    );
  }

  /** Fetch all raw data needed for the nextWorkout recommendation. */
  async getNextWorkoutData(endDate: string): Promise<NextWorkoutData> {
    const [
      latestMetrics,
      sleepRows,
      acwrRows,
      muscleFreshnessRows,
      balanceRows,
      zoneTotalsRows,
      hiitLoadRows,
      trainingDays,
    ] = await Promise.all([
      this.#fetchLatestMetrics(),
      this.#fetchLatestSleepEfficiency(),
      this.#fetchAcwr(endDate),
      this.#fetchMuscleFreshness(),
      this.#fetchBalance(endDate),
      this.#fetchZoneTotals(endDate),
      this.#fetchHiitLoad(endDate),
      this.#fetchTrainingDays(endDate),
    ]);

    return {
      latestMetric: latestMetrics[0] ?? null,
      latestSleepEfficiency: sleepRows[0]?.efficiency_pct ?? null,
      acwr: acwrRows[0]?.acwr ?? null,
      muscleFreshness: muscleFreshnessRows,
      balance: balanceRows[0] ?? {
        strength_7d: 0,
        endurance_7d: 0,
        last_strength_date: null,
        last_endurance_date: null,
      },
      zoneTotals: zoneTotalsRows[0] ?? {
        zone0: 0,
        zone1: 0,
        zone2: 0,
        zone3: 0,
        zone4: 0,
        zone5: 0,
      },
      hiitLoad: hiitLoadRows[0] ?? { hiit_count_7d: 0, last_hiit_date: null },
      trainingDates: trainingDays.map((day) => day.training_date),
    };
  }

  async #fetchLatestMetrics(): Promise<ReadinessMetricRow[]> {
    const endDate = new Date().toISOString().slice(0, 10);
    const restingHeartRateRows = await fetchRestingHeartRateRows({
      sensorStore: this.#sensorStore,
      userId: this.userId,
      timezone: this.timezone,
      endDate,
      days: 31,
    });
    const restingHeartRateCte = restingHeartRateValuesCte(restingHeartRateRows);

    return this.query(
      readinessMetricSchema,
      sql`WITH ${restingHeartRateCte},
        vitals_baseline AS (
          SELECT
            base.date,
            base.hrv,
            drhr.resting_hr,
            base.respiratory_rate_avg,
            AVG(base.hrv) OVER (ORDER BY base.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_mean_30d,
            STDDEV_POP(base.hrv) OVER (ORDER BY base.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_stddev_30d,
            AVG(drhr.resting_hr) OVER (ORDER BY base.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS resting_hr_mean_30d,
            STDDEV_POP(drhr.resting_hr) OVER (ORDER BY base.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS resting_hr_stddev_30d,
            AVG(base.respiratory_rate_avg) OVER (ORDER BY base.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS respiratory_rate_mean_30d,
            STDDEV_POP(base.respiratory_rate_avg) OVER (ORDER BY base.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS respiratory_rate_stddev_30d
          FROM (
            SELECT date, user_id, hrv, respiratory_rate_avg
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.userId}
              AND date > ${dateWindowStartString(endDate, 31)}::date
          ) base
          LEFT JOIN resting_heart_rate drhr
            ON drhr.date = base.date
          ORDER BY base.date ASC
        )
        SELECT
          vb.date::text AS date,
          vb.hrv,
          vb.resting_hr,
          vb.respiratory_rate_avg AS respiratory_rate,
          vb.hrv_mean_30d,
          vb.hrv_stddev_30d AS hrv_sd_30d,
          vb.resting_hr_mean_30d AS rhr_mean_30d,
          vb.resting_hr_stddev_30d AS rhr_sd_30d,
          vb.respiratory_rate_mean_30d AS rr_mean_30d,
          vb.respiratory_rate_stddev_30d AS rr_sd_30d
        FROM vitals_baseline vb
        ORDER BY vb.date DESC
        LIMIT 1`,
    );
  }

  async #fetchLatestSleepEfficiency(): Promise<z.infer<typeof sleepRowSchema>[]> {
    return this.query(
      sleepRowSchema,
      sql`SELECT efficiency_pct
        FROM fitness.v_sleep
        WHERE user_id = ${this.userId}
          AND is_nap = false
        ORDER BY COALESCE(ended_at, started_at + interval '8 hours') DESC
        LIMIT 1`,
    );
  }

  async #fetchAcwr(endDate: string): Promise<z.infer<typeof acwrRowSchema>[]> {
    // 28-day chronic + 7-day acute window. The CTE produces one row per day in
    // the window; we read the latest (today).
    return this.#sensorStore.query(
      acwrRowSchema,
      `WITH per_activity AS (
        SELECT
          toDate(toTimeZone(started_at, {timezone:String})) AS date,
          dateDiff('second', started_at, ended_at) / 60.0
            * avg_hr
            / nullIf(toFloat64(max_hr), 0) AS load
        FROM analytics.activity_summary
        WHERE user_id = {userId:UUID}
          AND toDate(toTimeZone(started_at, {timezone:String})) >= toDate({windowStart:String})
          AND ended_at IS NOT NULL
          AND avg_hr IS NOT NULL
      ),
      activity_load AS (
        SELECT date, sum(load) AS daily_load FROM per_activity GROUP BY date
      ),
      date_series AS (
        SELECT toDate({windowStart:String}) + INTERVAL number DAY AS date
        FROM numbers(toUInt64(28))
      ),
      daily AS (
        SELECT ds.date AS date, coalesce(al.daily_load, 0) AS daily_load
        FROM date_series ds
        LEFT JOIN activity_load al ON al.date = ds.date
      ),
      with_windows AS (
        SELECT
          date,
          sum(daily_load) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS acute_load,
          avg(daily_load) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_load_avg
        FROM daily
      )
      SELECT
        if(chronic_load_avg > 0, acute_load / (chronic_load_avg * 7), NULL) AS acwr
      FROM with_windows
      ORDER BY date DESC
      LIMIT 1`,
      {
        userId: this.userId,
        timezone: this.timezone,
        windowStart: dateWindowStartString(endDate, 28),
      },
    );
  }

  async #fetchMuscleFreshness(): Promise<MuscleFreshnessRow[]> {
    return this.query(
      muscleFreshnessSchema,
      sql`SELECT
          mg AS muscle_group,
          MAX((a.started_at AT TIME ZONE ${this.timezone})::date)::text AS last_trained_date
        FROM fitness.strength_set ss
        JOIN fitness.activity a ON a.id = ss.activity_id
        JOIN fitness.exercise e ON e.id = ss.exercise_id
        CROSS JOIN LATERAL unnest(e.muscle_groups) AS mg
        WHERE a.user_id = ${this.userId}
          AND a.activity_type = 'strength'
          AND e.muscle_groups IS NOT NULL
        GROUP BY mg`,
    );
  }

  async #fetchBalance(endDate: string): Promise<BalanceRow[]> {
    return this.query(
      balanceSchema,
      sql`WITH strength_data AS (
          SELECT
            COUNT(*) FILTER (WHERE started_at > ${timestampWindowStart(endDate, 7)})::int AS strength_7d,
            MAX((started_at AT TIME ZONE ${this.timezone})::date)::text AS last_strength_date
          FROM fitness.v_activity
          WHERE user_id = ${this.userId}
            AND activity_type = 'strength'
        ),
        endurance_data AS (
          SELECT
            COUNT(*) FILTER (WHERE started_at > ${timestampWindowStart(endDate, 7)})::int AS endurance_7d,
            MAX((started_at AT TIME ZONE ${this.timezone})::date)::text AS last_endurance_date
          FROM fitness.v_activity
          WHERE user_id = ${this.userId}
            AND ${enduranceTypeFilter("v_activity")}
            ${this.timestampAccessPredicate(sql`started_at`)}
        )
        SELECT
          s.strength_7d,
          e.endurance_7d,
          s.last_strength_date,
          e.last_endurance_date
        FROM strength_data s
        CROSS JOIN endurance_data e`,
    );
  }

  async #fetchZoneTotals(endDate: string): Promise<ZoneTotalsRow[]> {
    return this.#sensorStore.query(
      zoneTotalsSchema,
      `WITH ${restingHeartRateClickHouseCte()},
      activity_meta AS (
        SELECT
          asum.activity_id AS id,
          up.max_hr AS max_hr,
          coalesce(drhr.resting_hr, up.resting_hr, 60) AS resting_hr
        FROM analytics.activity_summary asum
        INNER JOIN analytics.v_activity a ON a.id = asum.activity_id
        INNER JOIN postgres_fitness.user_profile_current up ON up.id = asum.user_id
        LEFT JOIN resting_heart_rate drhr
          ON drhr.date = toString(toDate(asum.started_at))
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND asum.started_at > toDateTime({windowStart:String})
          AND up.max_hr IS NOT NULL
      )
      SELECT
        ${heartRateZoneCountColumns("ds.scalar", activityMetaHeartRateExpressions)}
      FROM analytics.deduped_sensor ds
      INNER JOIN activity_meta am ON am.id = ds.activity_id
      WHERE ds.channel = 'heart_rate' AND ds.scalar IS NOT NULL`,
      {
        userId: this.userId,
        timezone: this.timezone,
        windowStart: timestampWindowStartString(endDate, 14),
        rhrWindowStart: dateWindowStartString(endDate, 14),
        rhrEndDate: endDate,
        enduranceTypes: ENDURANCE_TYPES,
        ...heartRateZoneSqlParams(),
      },
    );
  }

  async #fetchHiitLoad(endDate: string): Promise<HiitLoadRow[]> {
    return this.#sensorStore.query(
      hiitLoadSchema,
      `WITH ${restingHeartRateClickHouseCte()},
      activity_meta AS (
        SELECT
          asum.activity_id AS id,
          toDate(toTimeZone(asum.started_at, {timezone:String})) AS activity_date,
          up.max_hr AS max_hr,
          coalesce(drhr.resting_hr, up.resting_hr, 60) AS resting_hr
        FROM analytics.activity_summary asum
        INNER JOIN analytics.v_activity a ON a.id = asum.activity_id
        INNER JOIN postgres_fitness.user_profile_current up ON up.id = asum.user_id
        LEFT JOIN resting_heart_rate drhr
          ON drhr.date = toString(toDate(asum.started_at))
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND asum.started_at > toDateTime({windowStart:String})
          AND up.max_hr IS NOT NULL
      ),
      per_activity AS (
        SELECT
          am.id AS id,
          any(am.activity_date) AS activity_date,
          maxIf(1, ds.scalar >= am.resting_hr + (am.max_hr - am.resting_hr) * {hiitThreshold:Float64}) > 0
            AS had_high_intensity
        FROM analytics.deduped_sensor ds
        INNER JOIN activity_meta am ON am.id = ds.activity_id
        WHERE ds.channel = 'heart_rate' AND ds.scalar IS NOT NULL
        GROUP BY am.id
      )
      SELECT
        toInt32(sum(if(had_high_intensity AND activity_date > toDate({sevenDayStart:String}), 1, 0))) AS hiit_count_7d,
        toString(max(if(had_high_intensity, activity_date, NULL))) AS last_hiit_date
      FROM per_activity`,
      {
        userId: this.userId,
        timezone: this.timezone,
        windowStart: timestampWindowStartString(endDate, 21),
        rhrWindowStart: dateWindowStartString(endDate, 21),
        rhrEndDate: endDate,
        sevenDayStart: dateWindowStartString(endDate, 7),
        enduranceTypes: ENDURANCE_TYPES,
        hiitThreshold: highIntensityZone.minPctHrr,
      },
    );
  }

  async #fetchTrainingDays(endDate: string): Promise<z.infer<typeof trainingDaySchema>[]> {
    return this.query(
      trainingDaySchema,
      sql`SELECT DISTINCT (started_at AT TIME ZONE ${this.timezone})::date::text AS training_date
          FROM fitness.activity
          WHERE user_id = ${this.userId}
            AND started_at > ${timestampWindowStart(endDate, 14)}
            ${this.timestampAccessPredicate(sql`started_at`)}
          ORDER BY training_date DESC`,
    );
  }

  /**
   * Recommendation logic moved from TrainingRouter for reuse in consolidated dashboard.
   */
  async getRecommendation(
    data: NextWorkoutData,
    endDate: string,
    weights: { hrv: number; restingHr: number; sleep: number; respiratoryRate: number },
  ): Promise<NextWorkoutRecommendation> {
    return buildNextWorkoutRecommendation(data, endDate, weights);
  }
}
