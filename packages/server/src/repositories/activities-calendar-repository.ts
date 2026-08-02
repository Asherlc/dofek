import type {
  ActivityDataState,
  ActivityDataStateUnavailableStatus,
} from "@dofek/format/activity-data-state";
import type {
  ActivityOverviewChange,
  ActivityOverviewChangeTrend,
  ActivityOverviewComparison,
  ActivityOverviewMeasurementChange,
} from "@dofek/format/activity-overview";
import {
  localTimeContextUnknown,
  localTimeSourceSchema,
  type RecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import type { ProviderAbsentSource } from "@dofek/providers/providers";
import { TrainingStressCalculator } from "@dofek/training/training-load";
import type { Database } from "dofek/db";
import { getProvider } from "dofek/providers/registry";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowEndExclusiveString, dateWindowStartString } from "../lib/date-window.ts";
import { type OsmTilePreview, osmTilePreview } from "../lib/osm-tile.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { ActivitySourceAttribution } from "../models/activity-source-attribution.ts";
import {
  type ActivityListSourceDetail,
  buildActivityListSource,
} from "../models/activity-source-decision.ts";
import { activityMeasurementState } from "../services/activity-data-state.ts";
import { type ActivitySensorStore, activityRepositoryFor } from "./activity-repository.ts";
import { getActivityRoutePreviews } from "./activity-route-preview.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ActivityLocation {
  centroidLat: number;
  centroidLng: number;
  mapPreview: OsmTilePreview;
}

export type ActivityStat =
  | {
      status: "available";
      label: string;
      value: string;
    }
  | {
      status: ActivityDataStateUnavailableStatus;
      label: string;
      reason: string;
    };

export interface CalendarActivityEntry {
  id: string;
  name: string | null;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  localTimeContext: RecordLocalTimeContext;
  durationMin: number;
  source: ActivityListSourceDetail;
  lastProcessedAt: string | null;
  distanceMeters: number | null;
  distanceState: ActivityDataState;
  elevationGainM: number | null;
  elevationState: ActivityDataState;
  location: ActivityLocation | null;
  tss: number | null;
  stats: ActivityStat[];
  isProviderAbsent?: boolean;
  providerId?: string;
  providerAbsentAt?: string | null;
  partialAbsentSources?: ProviderAbsentSource[];
}

export interface CalendarDayActivities {
  date: string;
  activities: CalendarActivityEntry[];
}

export interface ActivityOverview {
  activityCount: number;
  totalMinutes: number;
  totalDistanceMeters: number | null;
  totalDistanceState: ActivityDataState;
  totalElevationGainM: number | null;
  totalElevationState: ActivityDataState;
  activityTypes: string[];
  comparison: ActivityOverviewComparison;
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
  provider_id: z.string(),
  source_name: z.string().nullable(),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().nullable(),
  end_utc_offset_minutes: z.coerce.number().nullable(),
  local_time_source: localTimeSourceSchema,
  duration_min: z.coerce.number(),
  avg_hr: z.coerce.number().nullable(),
  max_hr: z.coerce.number().nullable(),
  avg_power: z.coerce.number().nullable(),
  total_distance: z.coerce.number().nullable(),
  elevation_gain_m: z.coerce.number().nullable(),
  centroid_lat: z.coerce.number().nullable(),
  centroid_lng: z.coerce.number().nullable(),
  local_date: dateStringSchema,
  last_processed_at: timestampStringSchema.nullable(),
  absent_source_external_ids: z
    .array(z.record(z.string(), z.string().nullable()))
    .optional()
    .default([]),
  source_external_ids: z.array(z.record(z.string(), z.string().nullable())).optional().default([]),
});

const baselineRowSchema = z.object({
  max_hr: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  ftp: z.coerce.number().nullable(),
});

const overviewRowSchema = z.object({
  current_activity_count: z.coerce.number(),
  current_total_minutes: z.coerce.number(),
  current_total_distance_meters: z.coerce.number().nullable(),
  current_total_elevation_gain_m: z.coerce.number().nullable(),
  current_distance_measurement_count: z.coerce.number(),
  current_elevation_measurement_count: z.coerce.number(),
  previous_activity_count: z.coerce.number(),
  previous_total_minutes: z.coerce.number(),
  previous_total_distance_meters: z.coerce.number().nullable(),
  previous_total_elevation_gain_m: z.coerce.number().nullable(),
  previous_distance_measurement_count: z.coerce.number(),
  previous_elevation_measurement_count: z.coerce.number(),
});

const activityTypeRowSchema = z.object({
  activity_type: z.string(),
});

const providerAbsentActivityRowSchema = activityRowSchema.extend({
  provider_id: z.string(),
  provider_absent_at: timestampStringSchema,
});

const activitySummaryMetricsRowSchema = z.object({
  id: z.string(),
  avg_hr: z.coerce.number().nullable(),
  max_hr: z.coerce.number().nullable(),
  avg_power: z.coerce.number().nullable(),
  total_distance: z.coerce.number().nullable(),
  elevation_gain_m: z.coerce.number().nullable(),
  centroid_lat: z.coerce.number().nullable(),
  centroid_lng: z.coerce.number().nullable(),
});

function authoritativeLocalTimeContext(
  row: Pick<
    z.infer<typeof activityRowSchema>,
    "timezone" | "start_utc_offset_minutes" | "end_utc_offset_minutes" | "local_time_source"
  >,
): RecordLocalTimeContext {
  if (row.local_time_source === "unknown") {
    return localTimeContextUnknown();
  }
  const timezone =
    row.local_time_source === "provider_timezone" || row.local_time_source === "device_timezone"
      ? row.timezone
      : null;
  return {
    timezone,
    startUtcOffsetMinutes: row.start_utc_offset_minutes,
    endUtcOffsetMinutes: row.end_utc_offset_minutes,
    source: row.local_time_source,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface WeekListInput {
  weeks: number;
  endDate: string;
  activityType?: string;
  includeProviderAbsent?: boolean;
}

/** Per-activity calendar data with route summaries and transparent training stress. */
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
    const activeDays = await this.#getActiveWeekList(input);
    if (!input.includeProviderAbsent) {
      return activeDays;
    }

    const hiddenDays = await this.#getProviderAbsentWeekList(input);
    return mergeDayGroups(activeDays, hiddenDays);
  }

  async #getActiveWeekList(input: WeekListInput): Promise<CalendarDayActivities[]> {
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
            activity.provider_id AS provider_id,
            activity.source_name AS source_name,
            activity.timezone AS timezone,
            activity.start_utc_offset_minutes AS start_utc_offset_minutes,
            activity.end_utc_offset_minutes AS end_utc_offset_minutes,
            activity.local_time_source AS local_time_source,
            dateDiff('second', activity.started_at, activity.ended_at) / 60.0 AS duration_min,
            asum.avg_hr AS avg_hr,
            asum.max_hr AS max_hr,
            asum.avg_power AS avg_power,
            asum.total_distance AS total_distance,
            asum.elevation_gain_m AS elevation_gain_m,
            asum.centroid_lat AS centroid_lat,
            asum.centroid_lng AS centroid_lng,
            activity.absent_source_external_ids AS absent_source_external_ids,
            activity.source_external_ids AS source_external_ids,
            toString(
              greatest(
                activity.refreshed_at,
                coalesce(asum.refreshed_at, activity.refreshed_at)
              )
            ) AS last_processed_at,
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

    const activityRowsMatchingType = filterActivityRowsByType(activityRows, input.activityType);
    const filteredActivityRows = await activityRepositoryFor(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).filterToVisibleActivities(activityRowsMatchingType);
    const locationActivityIds = filteredActivityRows
      .filter((row) => row.centroid_lat != null && row.centroid_lng != null)
      .map((row) => row.id);
    const routePreviewByActivityId = await getActivityRoutePreviews(
      this.#sensorStore,
      this.userId,
      locationActivityIds,
    );

    const baseline = baselineRows[0] ?? { max_hr: null, resting_hr: null, ftp: null };
    const calculator = new TrainingStressCalculator();

    const dayMap = new Map<string, CalendarActivityEntry[]>();
    for (const row of filteredActivityRows) {
      const trainingStress = computeActivityTrainingStress({
        durationMin: row.duration_min,
        avgPower: row.avg_power,
        avgHr: row.avg_hr,
        maxHr: row.max_hr,
        baselineMaxHr: baseline.max_hr,
        baselineRestingHr: baseline.resting_hr,
        ftp: baseline.ftp,
        calculator,
      });
      const tss = trainingStress.status === "available" ? trainingStress.score : null;

      const sourceAttribution = ActivitySourceAttribution.fromClickHouseRow(
        row.source_external_ids,
        row.absent_source_external_ids,
      );
      const sourceLinks = sourceAttribution.toSourceLinks(getProvider);

      const entry: CalendarActivityEntry = {
        id: row.id,
        name: row.name,
        activityType: row.activity_type,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        localTimeContext: authoritativeLocalTimeContext(row),
        durationMin: Math.round(row.duration_min * 10) / 10,
        source: buildActivityListSource(row.provider_id, row.source_name, sourceLinks, getProvider),
        lastProcessedAt: row.last_processed_at,
        partialAbsentSources: sourceAttribution.hasPartialAbsence
          ? sourceAttribution.partialAbsentSources()
          : undefined,
        distanceMeters: row.total_distance,
        distanceState: activityMeasurementState("Distance", row.total_distance),
        elevationGainM: row.elevation_gain_m,
        elevationState: activityMeasurementState("Elevation gain", row.elevation_gain_m),
        location:
          row.centroid_lat != null && row.centroid_lng != null
            ? {
                centroidLat: row.centroid_lat,
                centroidLng: row.centroid_lng,
                mapPreview:
                  routePreviewByActivityId.get(row.id) ??
                  osmTilePreview([{ lat: row.centroid_lat, lng: row.centroid_lng }]),
              }
            : null,
        tss: tss != null ? Math.round(tss * 10) / 10 : null,
        stats: formatActivityStats(trainingStress),
      };

      const bucket = dayMap.get(row.local_date) ?? [];
      bucket.push(entry);
      dayMap.set(row.local_date, bucket);
    }

    return Array.from(dayMap.entries())
      .map(([date, activities]) => ({ date, activities }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  async #getProviderAbsentWeekList(input: WeekListInput): Promise<CalendarDayActivities[]> {
    const days = input.weeks * 7;
    const windowStart = dateWindowStartString(input.endDate, days);
    const activityTypeFilter = activityTypeFilterSql(input);
    const queryParams = {
      ...activitySummaryQueryParams(this.userId, this.timezone, windowStart, input),
      ...this.#clickhouseTimestampAccessParams(),
    };

    const activityRows = await this.#sensorStore.query(
      providerAbsentActivityRowSchema,
      `SELECT
          toString(activity.id) AS id,
          activity.name AS name,
          activity.activity_type AS activity_type,
          toString(activity.started_at) AS started_at,
          toString(activity.ended_at) AS ended_at,
          activity.provider_id AS provider_id,
          activity.source_name AS source_name,
          activity.timezone AS timezone,
          activity.start_utc_offset_minutes AS start_utc_offset_minutes,
          activity.end_utc_offset_minutes AS end_utc_offset_minutes,
          activity.local_time_source AS local_time_source,
          dateDiff('second', activity.started_at, activity.ended_at) / 60.0 AS duration_min,
          NULL AS avg_hr,
          NULL AS max_hr,
          NULL AS avg_power,
          NULL AS total_distance,
          NULL AS elevation_gain_m,
          NULL AS centroid_lat,
          NULL AS centroid_lng,
          NULL AS last_processed_at,
          toString(toDate(toTimeZone(activity.started_at, {timezone:String}))) AS local_date,
          toString(activity.provider_absent_at) AS provider_absent_at
        FROM postgres_fitness.activity AS activity FINAL
        WHERE activity.user_id = {userId:UUID}
          AND activity._peerdb_is_deleted = 0
          AND activity.provider_absent_at IS NOT NULL
          AND activity.ended_at IS NOT NULL
          AND toDate(toTimeZone(activity.started_at, {timezone:String})) >= toDate({windowStart:String})
          ${activityTypeFilter}
          ${this.#clickhouseTimestampAccessClause()}
        ORDER BY activity.started_at DESC`,
      queryParams,
    );

    if (activityRows.length === 0) {
      return [];
    }

    const activityIds = activityRows.map((row) => row.id);
    const [summaryRows, baselineRows, routePreviewByActivityId] = await Promise.all([
      this.#fetchSummaryMetricsByActivityId(activityIds),
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
      getActivityRoutePreviews(this.#sensorStore, this.userId, activityIds),
    ]);

    const summaryByActivityId = new Map(summaryRows.map((row) => [row.id, row] as const));
    const enrichedRows = activityRows.map((row) => {
      const summary = summaryByActivityId.get(row.id);
      if (!summary) return row;
      return {
        ...row,
        avg_hr: summary.avg_hr,
        max_hr: summary.max_hr,
        avg_power: summary.avg_power,
        total_distance: summary.total_distance,
        elevation_gain_m: summary.elevation_gain_m,
        centroid_lat: summary.centroid_lat,
        centroid_lng: summary.centroid_lng,
      };
    });

    const baseline = baselineRows[0] ?? { max_hr: null, resting_hr: null, ftp: null };
    const calculator = new TrainingStressCalculator();

    const dayMap = new Map<string, CalendarActivityEntry[]>();
    for (const row of enrichedRows) {
      const trainingStress = computeActivityTrainingStress({
        durationMin: row.duration_min,
        avgPower: row.avg_power,
        avgHr: row.avg_hr,
        maxHr: row.max_hr,
        baselineMaxHr: baseline.max_hr,
        baselineRestingHr: baseline.resting_hr,
        ftp: baseline.ftp,
        calculator,
      });
      const tss = trainingStress.status === "available" ? trainingStress.score : null;

      const entry: CalendarActivityEntry = {
        id: row.id,
        name: row.name,
        activityType: row.activity_type,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        localTimeContext: authoritativeLocalTimeContext(row),
        durationMin: Math.round(row.duration_min * 10) / 10,
        source: buildActivityListSource(row.provider_id, row.source_name, undefined, getProvider),
        lastProcessedAt: row.last_processed_at,
        distanceMeters: row.total_distance,
        distanceState: activityMeasurementState("Distance", row.total_distance),
        elevationGainM: row.elevation_gain_m,
        elevationState: activityMeasurementState("Elevation gain", row.elevation_gain_m),
        location:
          row.centroid_lat != null && row.centroid_lng != null
            ? {
                centroidLat: row.centroid_lat,
                centroidLng: row.centroid_lng,
                mapPreview:
                  routePreviewByActivityId.get(row.id) ??
                  osmTilePreview([{ lat: row.centroid_lat, lng: row.centroid_lng }]),
              }
            : null,
        tss: tss != null ? Math.round(tss * 10) / 10 : null,
        stats: formatActivityStats(trainingStress),
        isProviderAbsent: true,
        providerId: row.provider_id,
        providerAbsentAt: row.provider_absent_at,
      };

      const bucket = dayMap.get(row.local_date) ?? [];
      bucket.push(entry);
      dayMap.set(row.local_date, bucket);
    }

    return Array.from(dayMap.entries()).map(([date, activities]) => ({ date, activities }));
  }

  #clickhouseTimestampAccessClause(): string {
    if (this.accessWindow.kind === "full") return "";
    return `
          AND toDate(toTimeZone(activity.started_at, {timezone:String})) >= toDate({accessStartDate:String})
          AND toDate(toTimeZone(activity.started_at, {timezone:String})) < toDate({accessEndDateExclusive:String})`;
  }

  #clickhouseTimestampAccessParams(): Record<string, string> {
    if (this.accessWindow.kind === "full") return {};
    return {
      accessStartDate: this.accessWindow.startDate,
      accessEndDateExclusive: this.accessWindow.endDateExclusive,
    };
  }

  async getActivityOverview(input: WeekListInput): Promise<ActivityOverview> {
    const days = input.weeks * 7;
    const currentWindowStart = dateWindowStartString(input.endDate, days);
    const previousWindowStart = dateWindowStartString(input.endDate, days * 2);
    const endDateExclusive = dateWindowEndExclusiveString(input.endDate);
    const activityRepository = activityRepositoryFor(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    );
    const visibleActivityIds = await activityRepository.listVisibleActivityIdsInRange(
      previousWindowStart,
      endDateExclusive,
    );
    if (visibleActivityIds.length === 0) {
      return createActivityOverview(
        emptyActivityOverviewPeriod(),
        emptyActivityOverviewPeriod(),
        [],
        input.weeks,
      );
    }
    const currentVisibleActivityIds = await activityRepository.listVisibleActivityIdsInRange(
      currentWindowStart,
      endDateExclusive,
    );

    const activityTypeFilter = activityTypeFilterSql(input);
    const queryParams = {
      ...activitySummaryQueryParams(this.userId, this.timezone, previousWindowStart, input),
      currentWindowStart,
      endDateExclusive,
      activityIds: visibleActivityIds,
    };
    const typeQueryParams = {
      ...activitySummaryQueryParams(this.userId, this.timezone, currentWindowStart, {}),
      endDateExclusive,
      activityIds: currentVisibleActivityIds,
    };
    const [overviewRows, activityTypeRows] = await Promise.all([
      this.#sensorStore.query(
        overviewRowSchema,
        `WITH toDate(toTimeZone(activity.started_at, {timezone:String})) AS activity_date
          SELECT
            countIf(
              activity_date >= toDate({currentWindowStart:String})
              AND activity_date < toDate({endDateExclusive:String})
            ) AS current_activity_count,
            coalesce(
              sumIf(
                dateDiff('second', activity.started_at, activity.ended_at) / 60.0,
                activity_date >= toDate({currentWindowStart:String})
                AND activity_date < toDate({endDateExclusive:String})
              ),
              0
            ) AS current_total_minutes,
            sumOrNullIf(
              summary.total_distance,
              activity_date >= toDate({currentWindowStart:String})
              AND activity_date < toDate({endDateExclusive:String})
            ) AS current_total_distance_meters,
            sumOrNullIf(
              summary.elevation_gain_m,
              activity_date >= toDate({currentWindowStart:String})
              AND activity_date < toDate({endDateExclusive:String})
            ) AS current_total_elevation_gain_m,
            countIf(
              activity_date >= toDate({currentWindowStart:String})
              AND activity_date < toDate({endDateExclusive:String})
              AND summary.total_distance IS NOT NULL
            ) AS current_distance_measurement_count,
            countIf(
              activity_date >= toDate({currentWindowStart:String})
              AND activity_date < toDate({endDateExclusive:String})
              AND summary.elevation_gain_m IS NOT NULL
            ) AS current_elevation_measurement_count,
            countIf(
              activity_date >= toDate({windowStart:String})
              AND activity_date < toDate({currentWindowStart:String})
            ) AS previous_activity_count,
            coalesce(
              sumIf(
                dateDiff('second', activity.started_at, activity.ended_at) / 60.0,
                activity_date >= toDate({windowStart:String})
                AND activity_date < toDate({currentWindowStart:String})
              ),
              0
            ) AS previous_total_minutes,
            sumOrNullIf(
              summary.total_distance,
              activity_date >= toDate({windowStart:String})
              AND activity_date < toDate({currentWindowStart:String})
            ) AS previous_total_distance_meters,
            sumOrNullIf(
              summary.elevation_gain_m,
              activity_date >= toDate({windowStart:String})
              AND activity_date < toDate({currentWindowStart:String})
            ) AS previous_total_elevation_gain_m,
            countIf(
              activity_date >= toDate({windowStart:String})
              AND activity_date < toDate({currentWindowStart:String})
              AND summary.total_distance IS NOT NULL
            ) AS previous_distance_measurement_count,
            countIf(
              activity_date >= toDate({windowStart:String})
              AND activity_date < toDate({currentWindowStart:String})
              AND summary.elevation_gain_m IS NOT NULL
            ) AS previous_elevation_measurement_count
          FROM analytics.deduped_activities AS activity FINAL
          LEFT JOIN analytics.activity_summary AS summary
            ON summary.user_id = activity.user_id
           AND summary.activity_id = activity.activity_id
          WHERE activity.user_id = {userId:UUID}
            AND activity.activity_id IN {activityIds:Array(UUID)}
            AND activity.is_deleted = 0
            AND activity.ended_at IS NOT NULL
            AND activity_date >= toDate({windowStart:String})
            AND activity_date < toDate({endDateExclusive:String})
            ${activityTypeFilter}`,
        queryParams,
      ),
      this.#sensorStore.query(
        activityTypeRowSchema,
        `WITH toDate(toTimeZone(activity.started_at, {timezone:String})) AS activity_date
          SELECT DISTINCT
            activity.activity_type AS activity_type
          FROM analytics.deduped_activities AS activity FINAL
          WHERE activity.user_id = {userId:UUID}
            AND activity.activity_id IN {activityIds:Array(UUID)}
            AND activity.is_deleted = 0
            AND activity.ended_at IS NOT NULL
            AND activity_date >= toDate({windowStart:String})
            AND activity_date < toDate({endDateExclusive:String})
          ORDER BY activity_type ASC`,
        typeQueryParams,
      ),
    ]);

    const overview = overviewRows[0] ?? {
      current_activity_count: 0,
      current_total_minutes: 0,
      current_total_distance_meters: null,
      current_total_elevation_gain_m: null,
      current_distance_measurement_count: 0,
      current_elevation_measurement_count: 0,
      previous_activity_count: 0,
      previous_total_minutes: 0,
      previous_total_distance_meters: null,
      previous_total_elevation_gain_m: null,
      previous_distance_measurement_count: 0,
      previous_elevation_measurement_count: 0,
    };

    return createActivityOverview(
      overviewPeriodFromRow(overview, "current"),
      overviewPeriodFromRow(overview, "previous"),
      activityTypeRows.map((row) => row.activity_type),
      input.weeks,
    );
  }

  async #fetchSummaryMetricsByActivityId(activityIds: string[]) {
    return this.#sensorStore.query(
      activitySummaryMetricsRowSchema,
      `SELECT
          toString(activity_id) AS id,
          avg_hr,
          max_hr,
          avg_power,
          total_distance,
          elevation_gain_m,
          centroid_lat,
          centroid_lng
        FROM analytics.activity_summary_rows FINAL
        WHERE user_id = {userId:UUID}
          AND activity_id IN {activityIds:Array(UUID)}
        ORDER BY refresh_version DESC
        LIMIT 1 BY activity_id`,
      { userId: this.userId, activityIds },
    );
  }
}

export function mergeDayGroups(
  activeDays: CalendarDayActivities[],
  hiddenDays: CalendarDayActivities[],
): CalendarDayActivities[] {
  const byDate = new Map<string, Map<string, CalendarActivityEntry>>();
  for (const group of [...activeDays, ...hiddenDays]) {
    let activitiesById = byDate.get(group.date);
    if (!activitiesById) {
      activitiesById = new Map();
      byDate.set(group.date, activitiesById);
    }
    for (const activity of group.activities) {
      if (!activitiesById.has(activity.id)) {
        activitiesById.set(activity.id, activity);
      }
    }
  }

  return Array.from(byDate.entries())
    .map(([date, activitiesById]) => ({
      date,
      activities: Array.from(activitiesById.values()).sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
      ),
    }))
    .sort((left, right) => right.date.localeCompare(left.date));
}

interface ActivityOverviewPeriod {
  activityCount: number;
  totalMinutes: number;
  totalDistanceMeters: number | null;
  totalDistanceState: ActivityDataState;
  totalElevationGainM: number | null;
  totalElevationState: ActivityDataState;
}

function emptyActivityOverviewPeriod(): ActivityOverviewPeriod {
  return {
    activityCount: 0,
    totalMinutes: 0,
    totalDistanceMeters: null,
    totalDistanceState: activityMeasurementState("Distance", null),
    totalElevationGainM: null,
    totalElevationState: activityMeasurementState("Elevation gain", null),
  };
}

function overviewPeriodFromRow(
  row: z.infer<typeof overviewRowSchema>,
  period: "current" | "previous",
): ActivityOverviewPeriod {
  const activityCount = Math.round(
    period === "current" ? row.current_activity_count : row.previous_activity_count,
  );
  const totalMinutes = roundMetric(
    period === "current" ? row.current_total_minutes : row.previous_total_minutes,
    1,
  );
  const totalDistanceMeters =
    period === "current" ? row.current_total_distance_meters : row.previous_total_distance_meters;
  const totalElevationGainM =
    period === "current" ? row.current_total_elevation_gain_m : row.previous_total_elevation_gain_m;
  const distanceMeasurementCount =
    period === "current"
      ? row.current_distance_measurement_count
      : row.previous_distance_measurement_count;
  const elevationMeasurementCount =
    period === "current"
      ? row.current_elevation_measurement_count
      : row.previous_elevation_measurement_count;
  const distanceComplete = distanceMeasurementCount === activityCount;
  const elevationComplete = elevationMeasurementCount === activityCount;
  const completeDistance = distanceComplete ? roundNullableMetric(totalDistanceMeters) : null;
  const completeElevation = elevationComplete ? roundNullableMetric(totalElevationGainM) : null;

  return {
    activityCount,
    totalMinutes,
    totalDistanceMeters: completeDistance,
    totalDistanceState: distanceComplete
      ? activityMeasurementState("Distance", completeDistance)
      : {
          status: "missing",
          reason: "Distance was not recorded for every activity.",
        },
    totalElevationGainM: completeElevation,
    totalElevationState: elevationComplete
      ? activityMeasurementState("Elevation gain", completeElevation)
      : {
          status: "missing",
          reason: "Elevation gain was not recorded for every activity.",
        },
  };
}

function createActivityOverview(
  current: ActivityOverviewPeriod,
  previous: ActivityOverviewPeriod,
  activityTypes: string[],
  weeks: number,
): ActivityOverview {
  return {
    ...current,
    activityTypes,
    comparison: {
      periodLabel: `previous ${weeks} weeks`,
      activityCount: createChange(current.activityCount, previous.activityCount, 0),
      totalMinutes: createChange(current.totalMinutes, previous.totalMinutes, 1),
      totalDistanceMeters: createMeasurementChange(
        current.totalDistanceMeters,
        current.totalDistanceState,
        previous.totalDistanceMeters,
        previous.totalDistanceState,
      ),
      totalElevationGainM: createMeasurementChange(
        current.totalElevationGainM,
        current.totalElevationState,
        previous.totalElevationGainM,
        previous.totalElevationState,
      ),
    },
  };
}

function createChange(current: number, previous: number, decimals: 0 | 1): ActivityOverviewChange {
  const difference = roundMetric(current - previous, decimals);
  return {
    magnitude: Math.abs(difference),
    trend: trendForDifference(difference),
  };
}

function createMeasurementChange(
  current: number | null,
  currentState: ActivityDataState,
  previous: number | null,
  previousState: ActivityDataState,
): ActivityOverviewMeasurementChange {
  if (currentState.status !== "available") {
    return { magnitude: null, trend: "unavailable", state: currentState };
  }
  if (previousState.status !== "available") {
    return {
      magnitude: null,
      trend: "unavailable",
      state: {
        status: previousState.status,
        reason: `Previous period: ${previousState.reason}`,
      },
    };
  }
  if (current == null || previous == null) {
    return {
      magnitude: null,
      trend: "unavailable",
      state: {
        status: "failed",
        reason: "A complete comparison value was not returned.",
      },
    };
  }

  const difference = roundMetric(current - previous, 1);
  return {
    magnitude: Math.abs(difference),
    trend: trendForDifference(difference),
    state: { status: "available" },
  };
}

function trendForDifference(difference: number): ActivityOverviewChangeTrend {
  if (difference > 0) return "higher";
  if (difference < 0) return "lower";
  return "unchanged";
}

function roundMetric(value: number, decimals: 0 | 1): number {
  const factor = decimals === 0 ? 1 : 10;
  return Math.round(value * factor) / factor;
}

function roundNullableMetric(value: number | null): number | null {
  return value == null ? null : roundMetric(value, 1);
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

type ActivityTrainingStress =
  | {
      status: "available";
      score: number;
    }
  | {
      status: "missing";
      reason: string;
    };

function computeActivityTrainingStress(input: TssInput): ActivityTrainingStress {
  if (input.durationMin <= 0) {
    return {
      status: "missing",
      reason: "Record an activity duration greater than zero.",
    };
  }
  if (input.avgPower != null && input.avgPower > 0 && input.ftp != null && input.ftp > 0) {
    return {
      status: "available",
      score: TrainingStressCalculator.computePowerTss(input.avgPower, input.ftp, input.durationMin),
    };
  }
  const effectiveMaxHr = input.baselineMaxHr ?? input.maxHr;
  const effectiveRestingHr = input.baselineRestingHr ?? 60;
  if (
    input.avgHr != null &&
    input.avgHr > 0 &&
    effectiveMaxHr != null &&
    effectiveMaxHr > effectiveRestingHr
  ) {
    return {
      status: "available",
      score: input.calculator.computeHrTss(
        input.durationMin,
        input.avgHr,
        effectiveMaxHr,
        effectiveRestingHr,
      ),
    };
  }
  return {
    status: "missing",
    reason: formatTrainingStressUnavailableReason(input, effectiveMaxHr, effectiveRestingHr),
  };
}

function formatTrainingStressUnavailableReason(
  input: TssInput,
  effectiveMaxHr: number | null,
  effectiveRestingHr: number,
): string {
  const powerActions: string[] = [];
  if (input.avgPower == null || input.avgPower <= 0) {
    powerActions.push("record average power");
  }
  if (input.ftp == null || input.ftp <= 0) {
    powerActions.push("set functional threshold power");
  }

  const heartRateActions: string[] = [];
  if (input.avgHr == null || input.avgHr <= 0) {
    heartRateActions.push("record average heart rate");
  }
  if (effectiveMaxHr == null || effectiveMaxHr <= 0) {
    heartRateActions.push("set maximum heart rate");
  } else if (effectiveMaxHr <= effectiveRestingHr) {
    heartRateActions.push("set maximum heart rate above resting heart rate");
  }

  const powerAction = joinActions(powerActions);
  const heartRateAction = joinActions(heartRateActions);
  return `${capitalize(powerAction)}, or ${heartRateAction}.`;
}

function joinActions(actions: string[]): string {
  return actions.join(" and ");
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function formatActivityStats(trainingStress: ActivityTrainingStress): ActivityStat[] {
  if (trainingStress.status === "missing") {
    return [
      {
        status: "missing",
        label: "Training Stress Score",
        reason: trainingStress.reason,
      },
    ];
  }
  const roundedTss = Math.round(trainingStress.score * 10) / 10;
  return [
    {
      status: "available",
      label: "Training Stress Score",
      value: formatStatNumber(roundedTss),
    },
  ];
}

function formatStatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
