import { TrainingStressCalculator } from "@dofek/training/training-load";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { osmTileUrl } from "../lib/osm-tile.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { getActivityRoutePreviews } from "./activity-route-preview.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ActivityLocation {
  centroidLat: number;
  centroidLng: number;
  tileUrl: string;
  routePath: { x: number; y: number }[] | null;
  distanceMeters: number | null;
  elevationGainM: number | null;
}

export interface ActivityStat {
  label: string;
  value: string;
}

export interface CalendarActivityEntry {
  id: string;
  name: string | null;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  durationMin: number;
  location: ActivityLocation | null;
  calories: number | null;
  tss: number | null;
  stats: ActivityStat[];
}

export interface CalendarDayActivities {
  date: string;
  activities: CalendarActivityEntry[];
}

export interface ActivityOverview {
  activityCount: number;
  totalMinutes: number;
  totalDistanceMeters: number;
  totalElevationGainM: number;
  activityTypes: string[];
}

// ---------------------------------------------------------------------------
// Internal schemas
// ---------------------------------------------------------------------------

const activityRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  activity_type: z.string(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  duration_min: z.coerce.number(),
  avg_hr: z.coerce.number().nullable(),
  max_hr: z.coerce.number().nullable(),
  avg_power: z.coerce.number().nullable(),
  total_distance: z.coerce.number().nullable(),
  elevation_gain_m: z.coerce.number().nullable(),
  centroid_lat: z.coerce.number().nullable(),
  centroid_lng: z.coerce.number().nullable(),
  local_date: dateStringSchema,
});

const caloriesRowSchema = z.object({
  id: z.string(),
  calories: z.coerce.number().nullable(),
});

const baselineRowSchema = z.object({
  max_hr: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  ftp: z.coerce.number().nullable(),
});

const overviewRowSchema = z.object({
  activity_count: z.coerce.number(),
  total_minutes: z.coerce.number(),
  total_distance_meters: z.coerce.number(),
  total_elevation_gain_m: z.coerce.number(),
});

const activityTypeRowSchema = z.object({
  activity_type: z.string(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface WeekListInput {
  weeks: number;
  endDate: string;
  activityType?: string;
}

/** Per-activity calendar data (location for outdoor, calories + TSS otherwise). */
export class ActivitiesCalendarRepository extends BaseRepository {
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

  async getWeekList(input: WeekListInput): Promise<CalendarDayActivities[]> {
    const days = input.weeks * 7;
    const windowStart = dateWindowStartString(input.endDate, days);
    const activityTypeFilter = activityTypeFilterSql(input);
    const queryParams = activitySummaryQueryParams(this.userId, this.timezone, windowStart, input);

    const [activityRows, baselineRows] = await Promise.all([
      this.#sensorStore.query(
        activityRowSchema,
        `SELECT
            toString(activity.activity_id) AS id,
            activity.name AS name,
            activity.activity_type AS activity_type,
            toString(activity.started_at) AS started_at,
            toString(activity.ended_at) AS ended_at,
            dateDiff('second', activity.started_at, activity.ended_at) / 60.0 AS duration_min,
            asum.avg_hr AS avg_hr,
            asum.max_hr AS max_hr,
            asum.avg_power AS avg_power,
            asum.total_distance AS total_distance,
            asum.elevation_gain_m AS elevation_gain_m,
            asum.centroid_lat AS centroid_lat,
            asum.centroid_lng AS centroid_lng,
            toString(toDate(toTimeZone(activity.started_at, {timezone:String}))) AS local_date
          FROM analytics.deduped_activities AS activity FINAL
          LEFT JOIN analytics.activity_summary asum
            ON asum.user_id = activity.user_id
           AND asum.activity_id = activity.activity_id
          WHERE activity.user_id = {userId:UUID}
            AND activity.is_deleted = 0
            AND activity.ended_at IS NOT NULL
            AND toDate(toTimeZone(activity.started_at, {timezone:String})) >= toDate({windowStart:String})
            ${activityTypeFilter}
          ORDER BY activity.started_at DESC`,
        queryParams,
      ),
      this.#sensorStore.query(
        baselineRowSchema,
        `SELECT
            up.max_hr AS max_hr,
            up.resting_hr AS resting_hr,
            up.ftp AS ftp
          FROM postgres_fitness.user_profile_current up
          WHERE up.id = {userId:UUID}`,
        { userId: this.userId },
      ),
    ]);

    const filteredActivityRows = filterActivityRowsByType(activityRows, input.activityType);
    const activityIds = filteredActivityRows.map((row) => row.id);
    const [caloriesRows, routePreviewByActivityId] = await Promise.all([
      this.#fetchCaloriesByActivityId(activityIds),
      getActivityRoutePreviews(this.#sensorStore, this.userId, activityIds),
    ]);

    const caloriesByActivityId = new Map(
      caloriesRows.map((row) => [row.id, row.calories] as const),
    );

    const baseline = baselineRows[0] ?? { max_hr: null, resting_hr: null, ftp: null };
    const calculator = new TrainingStressCalculator();

    const dayMap = new Map<string, CalendarActivityEntry[]>();
    for (const row of filteredActivityRows) {
      const calories = caloriesByActivityId.get(row.id) ?? null;
      const tss = computeActivityTss({
        durationMin: row.duration_min,
        avgPower: row.avg_power,
        avgHr: row.avg_hr,
        maxHr: row.max_hr,
        baselineMaxHr: baseline.max_hr,
        baselineRestingHr: baseline.resting_hr,
        ftp: baseline.ftp,
        calculator,
      });

      const entry: CalendarActivityEntry = {
        id: row.id,
        name: row.name,
        activityType: row.activity_type,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationMin: Math.round(row.duration_min * 10) / 10,
        location:
          row.centroid_lat != null && row.centroid_lng != null
            ? {
                centroidLat: row.centroid_lat,
                centroidLng: row.centroid_lng,
                tileUrl:
                  routePreviewByActivityId.get(row.id)?.tileUrl ??
                  osmTileUrl(row.centroid_lat, row.centroid_lng),
                routePath: routePreviewByActivityId.get(row.id)?.routePath ?? null,
                distanceMeters: row.total_distance,
                elevationGainM: row.elevation_gain_m,
              }
            : null,
        calories,
        tss: tss != null ? Math.round(tss * 10) / 10 : null,
        stats: formatActivityStats(tss, calories),
      };

      const bucket = dayMap.get(row.local_date) ?? [];
      bucket.push(entry);
      dayMap.set(row.local_date, bucket);
    }

    return Array.from(dayMap.entries())
      .map(([date, activities]) => ({ date, activities }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  async getActivityOverview(input: WeekListInput): Promise<ActivityOverview> {
    const days = input.weeks * 7;
    const windowStart = dateWindowStartString(input.endDate, days);
    const activityTypeFilter = activityTypeFilterSql(input);
    const queryParams = activitySummaryQueryParams(this.userId, this.timezone, windowStart, input);
    const typeQueryParams = activitySummaryQueryParams(this.userId, this.timezone, windowStart, {});

    const [overviewRows, activityTypeRows] = await Promise.all([
      this.#sensorStore.query(
        overviewRowSchema,
        `SELECT
            count() AS activity_count,
            coalesce(sum(dateDiff('second', activity.started_at, activity.ended_at) / 60.0), 0) AS total_minutes,
            coalesce(sum(coalesce(asum.total_distance, 0)), 0) AS total_distance_meters,
            coalesce(sum(coalesce(asum.elevation_gain_m, 0)), 0) AS total_elevation_gain_m
          FROM analytics.deduped_activities AS activity FINAL
          LEFT JOIN analytics.activity_summary asum
            ON asum.user_id = activity.user_id
           AND asum.activity_id = activity.activity_id
          WHERE activity.user_id = {userId:UUID}
            AND activity.is_deleted = 0
            AND activity.ended_at IS NOT NULL
            AND toDate(toTimeZone(activity.started_at, {timezone:String})) >= toDate({windowStart:String})
            ${activityTypeFilter}`,
        queryParams,
      ),
      this.#sensorStore.query(
        activityTypeRowSchema,
        `SELECT DISTINCT
            activity.activity_type AS activity_type
          FROM analytics.deduped_activities AS activity FINAL
          WHERE activity.user_id = {userId:UUID}
            AND activity.is_deleted = 0
            AND activity.ended_at IS NOT NULL
            AND toDate(toTimeZone(activity.started_at, {timezone:String})) >= toDate({windowStart:String})
          ORDER BY activity_type ASC`,
        typeQueryParams,
      ),
    ]);

    const overview = overviewRows[0] ?? {
      activity_count: 0,
      total_minutes: 0,
      total_distance_meters: 0,
      total_elevation_gain_m: 0,
    };

    return {
      activityCount: Math.round(overview.activity_count),
      totalMinutes: Math.round(overview.total_minutes * 10) / 10,
      totalDistanceMeters: Math.round(overview.total_distance_meters * 10) / 10,
      totalElevationGainM: Math.round(overview.total_elevation_gain_m * 10) / 10,
      activityTypes: activityTypeRows.map((row) => row.activity_type),
    };
  }

  async #fetchCaloriesByActivityId(activityIds: string[]) {
    if (activityIds.length === 0) return [];
    const activityIdFilter = sql.join(
      activityIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    );
    return this.query(
      caloriesRowSchema,
      sql`SELECT
            a.id::text AS id,
            NULLIF(a.raw->>'calories', '')::numeric AS calories
          FROM fitness.activity a
          WHERE a.user_id = ${this.userId}::uuid
            AND a.provider_absent_at IS NULL
            AND a.deleted_at IS NULL
            AND a.id IN (${activityIdFilter})
            AND a.raw ? 'calories'`,
    );
  }
}

function activityTypeFilterSql(input: Pick<WeekListInput, "activityType">): string {
  return input.activityType ? "AND activity.activity_type = {activityType:String}" : "";
}

function activitySummaryQueryParams(
  userId: string,
  timezone: string,
  windowStart: string,
  input: Pick<WeekListInput, "activityType">,
) {
  return {
    userId,
    timezone,
    windowStart,
    ...(input.activityType ? { activityType: input.activityType } : {}),
  };
}

function filterActivityRowsByType(
  activityRows: z.infer<typeof activityRowSchema>[],
  activityType: string | undefined,
) {
  return activityType
    ? activityRows.filter((activityRow) => activityRow.activity_type === activityType)
    : activityRows;
}

// ---------------------------------------------------------------------------
// TSS computation (server-side, per CLAUDE.md "Server-side metric computation")
// ---------------------------------------------------------------------------

interface TssInput {
  durationMin: number;
  avgPower: number | null;
  avgHr: number | null;
  maxHr: number | null;
  baselineMaxHr: number | null;
  baselineRestingHr: number | null;
  ftp: number | null;
  calculator: TrainingStressCalculator;
}

function computeActivityTss(input: TssInput): number | null {
  if (input.durationMin <= 0) return null;
  if (input.avgPower != null && input.avgPower > 0 && input.ftp != null && input.ftp > 0) {
    return TrainingStressCalculator.computePowerTss(input.avgPower, input.ftp, input.durationMin);
  }
  const effectiveMaxHr = input.baselineMaxHr ?? input.maxHr;
  const effectiveRestingHr = input.baselineRestingHr ?? 60;
  if (
    input.avgHr != null &&
    input.avgHr > 0 &&
    effectiveMaxHr != null &&
    effectiveMaxHr > effectiveRestingHr
  ) {
    return input.calculator.computeHrTss(
      input.durationMin,
      input.avgHr,
      effectiveMaxHr,
      effectiveRestingHr,
    );
  }
  return null;
}

function formatActivityStats(tss: number | null, calories: number | null): ActivityStat[] {
  const roundedTss = tss != null ? Math.round(tss * 10) / 10 : null;
  return [
    {
      label: "Training Stress Score",
      value: roundedTss != null ? formatStatNumber(roundedTss) : "—",
    },
    { label: "Calories", value: calories != null ? `${Math.round(calories)} kcal` : "—" },
  ];
}

function formatStatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
