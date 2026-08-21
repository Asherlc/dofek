import type { ActivityDataState } from "@dofek/format/activity-data-state";
import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import {
  buildKarvonenIntensityDistribution,
  type IntensityDistribution,
} from "@dofek/training/training-distribution";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { ChartRange } from "../lib/chart-range.ts";
import type { RangeDays } from "../lib/date-window.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { activityMeasurementState } from "../services/activity-data-state.ts";
import { type ActivitySensorStore, activityRepositoryFor } from "./activity-repository.ts";
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
  canonical_type: z.string(),
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

export interface TrainingHrZonesResult {
  maxHr: number | null;
  weeks: HrZoneRow[];
  intensityDistribution: IntensityDistribution;
}

const activityStatsRowSchema = z.object({
  id: z.string(),
  canonical_type: z.string(),
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

export type ActivityStatsRow = z.infer<typeof activityStatsRowSchema> & {
  distance_state: ActivityDataState;
};

const rawActivityCountRowSchema = z.object({
  activity_count: z.coerce.number(),
});

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
  async getWeeklyVolume(days: RangeDays): Promise<WeeklyVolumeRow[]> {
    const rawActivityCount = await this.#loadRawActivityCount(
      days,
      undefined,
      true,
      this.accessWindow,
    );
    if (rawActivityCount === 0) {
      return [];
    }

    return this.#queryWeeklyVolume(days);
  }

  /** HR zone distribution per week using the canonical Karvonen model. */
  async getHrZones(days: RangeDays): Promise<TrainingHrZonesResult> {
    const rawActivityCount = await this.#loadRawActivityCount(days, ENDURANCE_TYPES, true);
    if (rawActivityCount === 0) {
      return {
        maxHr: null,
        weeks: [],
        intensityDistribution: buildKarvonenIntensityDistribution([]),
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    const range = ChartRange.fromDays(days);
    const activityRangeFilter = range.clickHouseDateAfterToday("asum.started_at");
    const rhrWindowStart = range.windowStartString(today);
    const rows = await this.#sensorStore.query(
      hrZoneRowSchema,
      `WITH ${restingHeartRateClickHouseCte({ includeWindowStart: days !== null })},
      activity_meta AS (
        SELECT
          asum.activity_id AS id,
          asum.user_id AS user_id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at,
          toDate(toTimeZone(asum.started_at, {timezone:String})) AS activity_date,
          nullIf(up.max_hr, 0) AS max_hr,
          coalesce(drhr.resting_hr, nullIf(up.resting_hr, 0), 60) AS resting_hr
        FROM analytics.activity_summary asum
        INNER JOIN analytics.deduped_activities activity FINAL
          ON activity.activity_id = asum.activity_id
         AND activity.user_id = asum.user_id
        INNER JOIN postgres_fitness.user_profile_current up ON up.id = asum.user_id
        LEFT JOIN resting_heart_rate drhr
          ON drhr.date = toString(toDate(asum.started_at))
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, asum.canonical_type)
          ${activityRangeFilter}
          AND activity.is_deleted = 0
          AND up.max_hr > 0
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
        rhrEndDate: today,
        ...(rhrWindowStart ? { rhrWindowStart } : {}),
        ...range.params(),
        enduranceTypes: ENDURANCE_TYPES,
        ...heartRateZoneSqlParams(),
      },
    );
    const rawMaxHr = rows[0]?.max_hr;
    const maxHr = typeof rawMaxHr === "number" ? rawMaxHr : null;
    if (!maxHr) {
      return {
        maxHr: null,
        weeks: [],
        intensityDistribution: buildKarvonenIntensityDistribution([]),
      };
    }
    return {
      maxHr,
      weeks: rows,
      intensityDistribution: buildKarvonenIntensityDistribution(rows),
    };
  }

  /** Per-activity summary with HR and power stats. */
  async getActivityStats(days: RangeDays): Promise<ActivityStatsRow[]> {
    const rawActivityCount = await this.#loadRawActivityCount(
      days,
      undefined,
      false,
      this.accessWindow,
    );
    if (rawActivityCount === 0) {
      return [];
    }

    return this.#queryActivityStats(days);
  }

  /** Activity stats and weekly volume with a single activity-count lookup. */
  async getActivityStatsAndWeeklyVolume(days: RangeDays): Promise<{
    activities: ActivityStatsRow[];
    weeklyVolume: WeeklyVolumeRow[];
  }> {
    const rawActivityCount = await this.#loadRawActivityCount(
      days,
      undefined,
      false,
      this.accessWindow,
    );
    if (rawActivityCount === 0) {
      return { activities: [], weeklyVolume: [] };
    }

    const [activities, weeklyVolume] = await Promise.all([
      this.#queryActivityStats(days),
      this.#queryWeeklyVolume(days),
    ]);
    return { activities, weeklyVolume };
  }

  #activitySummaryAccessFilter(tableAlias = ""): {
    predicate: string;
    params: Record<string, string>;
  } {
    const columnPrefix = tableAlias ? `${tableAlias}.` : "";
    if (this.accessWindow.kind === "full") {
      return { predicate: "", params: {} };
    }
    return {
      predicate: `AND ${columnPrefix}started_at >= toDateTime({accessStart:String})
       AND ${columnPrefix}started_at < toDateTime({accessEnd:String})`,
      params: {
        accessStart: this.accessWindow.startDate,
        accessEnd: this.accessWindow.endDateExclusive,
      },
    };
  }

  async #queryActivityStats(days: RangeDays): Promise<ActivityStatsRow[]> {
    const { predicate, params } = this.#activitySummaryAccessFilter("a");
    const range = ChartRange.fromDays(days);
    const rangeFilter = range.clickHouseDateAfterToday("a.started_at");
    const rows = await this.#sensorStore.query(
      activityStatsRowSchema,
      `SELECT
        toString(a.activity_id) AS id,
        a.canonical_type AS canonical_type,
        a.name AS name,
        formatDateTime(a.started_at, '%Y-%m-%dT%H:%i:%SZ') AS started_at,
        formatDateTime(a.ended_at, '%Y-%m-%dT%H:%i:%SZ') AS ended_at,
        round(a.avg_hr, 1) AS avg_hr,
        a.max_hr AS max_hr,
        round(a.avg_power, 1) AS avg_power,
        a.max_power AS max_power,
        round(a.avg_cadence, 1) AS avg_cadence,
        coalesce(a.hr_sample_count, 0) AS hr_samples,
        coalesce(a.power_sample_count, 0) AS power_samples,
        a.total_distance AS distance_meters
      FROM analytics.activity_summary a
      WHERE a.user_id = {userId:UUID}
        ${rangeFilter}
        ${predicate}
      ORDER BY a.started_at DESC`,
      { userId: this.userId, ...range.params(), ...params },
    );
    const visibleRows = await activityRepositoryFor(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).filterToVisibleActivities(rows);
    return visibleRows.map((row) => ({
      ...row,
      distance_state: activityMeasurementState("Distance", row.distance_meters),
    }));
  }

  async #queryWeeklyVolume(days: RangeDays): Promise<WeeklyVolumeRow[]> {
    const { predicate, params } = this.#activitySummaryAccessFilter("asum");
    const range = ChartRange.fromDays(days);
    const rangeFilter = range.clickHouseDateAfterToday("asum.started_at");

    return this.#sensorStore.query(
      weeklyVolumeRowSchema,
      `SELECT
        toString(toMonday(toDate(toTimeZone(asum.started_at, {timezone:String})))) AS week,
        asum.canonical_type,
        toInt32(count()) AS count,
        round(sum(dateDiff('second', asum.started_at, asum.ended_at)) / 3600, 2) AS hours
      FROM analytics.activity_summary asum
      INNER JOIN analytics.deduped_activities activity FINAL
        ON activity.activity_id = asum.activity_id
       AND activity.user_id = asum.user_id
      WHERE asum.user_id = {userId:UUID}
        ${rangeFilter}
        AND asum.ended_at IS NOT NULL
        AND activity.is_deleted = 0
        ${predicate}
      GROUP BY week, canonical_type
      ORDER BY week`,
      {
        userId: this.userId,
        timezone: this.timezone,
        ...range.params(),
        ...params,
      },
    );
  }

  async #loadRawActivityCount(
    days: RangeDays,
    activityTypes?: string[],
    requireEndedAt = false,
    accessWindow?: AccessWindow,
  ): Promise<number> {
    const activityTypePredicate =
      activityTypes && activityTypes.length > 0
        ? sql`AND canonical_type IN (${sql.join(
            activityTypes.map((activityType) => sql`${activityType}`),
            sql`, `,
          )})`
        : sql``;
    const endedAtPredicate = requireEndedAt ? sql`AND ended_at IS NOT NULL` : sql``;
    const resolvedAccessWindow = accessWindow ?? this.accessWindow;
    const accessWindowPredicate =
      resolvedAccessWindow.kind === "limited"
        ? sql`AND started_at >= ${resolvedAccessWindow.startDate}::timestamptz
              AND started_at < ${resolvedAccessWindow.endDateExclusive}::timestamptz`
        : sql``;
    const rangeFilter = ChartRange.fromDays(days).currentDateAfter(sql`started_at::date`, ">=");
    const rows = await this.query(
      rawActivityCountRowSchema,
      sql`SELECT count(*)::int AS activity_count
          FROM fitness.v_activity
          WHERE user_id = ${this.userId}::uuid
            ${rangeFilter}
            ${endedAtPredicate}
            ${activityTypePredicate}
            ${accessWindowPredicate}`,
    );
    return rows[0]?.activity_count ?? 0;
  }
}
