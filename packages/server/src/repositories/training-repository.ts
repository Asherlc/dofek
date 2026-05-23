import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import type { Database } from "dofek/db";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  heartRateZoneCountColumns,
  heartRateZoneSqlParams,
  heartRateZoneSumColumns,
} from "./heart-rate-zone-sql.ts";
import { restingHeartRateClickHouseCte } from "./resting-heart-rate-query.ts";

const ENDURANCE_TYPES: string[] = [...ENDURANCE_ACTIVITY_TYPES];

const activityMetaHeartRateExpressions = {
  maxHr: "am.max_hr",
  restingHr: "am.resting_hr",
};

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
          asum.user_id AS user_id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at,
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
        INNER JOIN activity_meta am
          ON ds.user_id = am.user_id
         AND ds.recorded_at >= am.started_at
         AND ds.recorded_at <= coalesce(am.ended_at, am.started_at + INTERVAL 12 HOUR)
        WHERE ds.channel = 'heart_rate'
          AND ds.scalar IS NOT NULL
          AND ds.is_deleted = 0
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
          a.id AS activity_id,
          countIf(samples.channel = 'heart_rate') AS hr_samples,
          countIf(samples.channel = 'power') AS power_samples
        FROM analytics.deduped_sensor AS samples
        INNER JOIN analytics.v_activity AS a
          ON a.user_id = samples.user_id
         AND samples.recorded_at >= a.started_at
         AND samples.recorded_at <= coalesce(a.ended_at, a.started_at + INTERVAL 12 HOUR)
        WHERE samples.user_id = {userId:UUID}
          AND samples.channel IN ('heart_rate', 'power')
          AND samples.is_deleted = 0
        GROUP BY a.id
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
}
