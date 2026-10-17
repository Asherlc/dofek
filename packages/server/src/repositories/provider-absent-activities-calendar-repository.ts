import { TrainingStressCalculator } from "@dofek/training/training-load";
import type { Database } from "dofek/db";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { timestampStringSchema } from "../lib/typed-sql.ts";
import {
  activityRowSchema,
  baselineRowSchema,
  type CalendarActivityEntry,
  type CalendarDayActivities,
  createProviderAbsentCalendarEntry,
  type WeekListInput,
} from "./activity-calendar-entry.ts";
import { clickHouseActivityCalendarDate } from "./activity-local-date.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { getActivityMapReadiness, getActivityRoutePreviews } from "./activity-route-preview.ts";

const providerAbsentActivityRowSchema = activityRowSchema.extend({
  route_activity_id: z.string(),
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

export class ProviderAbsentActivitiesCalendarRepository extends BaseRepository {
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
    const activityTypeFilter = input.activityType
      ? "AND activity.canonical_type = {activityType:String}"
      : "";
    const activityDate = clickHouseActivityCalendarDate("activity");
    const queryParams = {
      userId: this.userId,
      timezone: this.timezone,
      windowStart,
      ...(input.activityType ? { activityType: input.activityType } : {}),
      ...this.#clickhouseTimestampAccessParams(),
    };

    const activityRows = await this.#sensorStore.query(
      providerAbsentActivityRowSchema,
      `SELECT
          toString(activity.id) AS id,
          toString(activity.group_id) AS route_activity_id,
          activity.name AS name,
          activity.canonical_type AS canonical_type,
          activity.modality AS modality,
          toString(activity.started_at) AS started_at,
          toString(activity.ended_at) AS ended_at,
          activity.provider_id AS provider_id,
          activity.source_name AS source_name,
          [activity.id] AS member_activity_ids,
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
          toString(${activityDate}) AS local_date,
          toString(activity.provider_absent_at) AS provider_absent_at
        FROM postgres_fitness.activity AS activity FINAL
        WHERE activity.user_id = {userId:UUID}
          AND activity._peerdb_is_deleted = 0
          AND activity.provider_absent_at IS NOT NULL
          AND activity.ended_at IS NOT NULL
          AND ${activityDate} >= toDate({windowStart:String})
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
    const mapReadinessByActivityId = await getActivityMapReadiness(
      this.#sensorStore,
      this.userId,
      enrichedRows
        .filter((row) => row.centroid_lat == null || row.centroid_lng == null)
        .map((row) => ({
          id: row.id,
          routeActivityId: row.route_activity_id,
          memberActivityIds: row.member_activity_ids,
        })),
    );
    const calculator = new TrainingStressCalculator();

    const dayMap = new Map<string, CalendarActivityEntry[]>();
    for (const row of enrichedRows) {
      const entry = createProviderAbsentCalendarEntry(row, {
        baseline,
        calculator,
        routePreview: routePreviewByActivityId.get(row.id),
        mapReadiness: mapReadinessByActivityId.get(row.id),
      });

      const bucket = dayMap.get(row.local_date) ?? [];
      bucket.push(entry);
      dayMap.set(row.local_date, bucket);
    }

    return Array.from(dayMap.entries()).map(([date, activities]) => ({ date, activities }));
  }

  #clickhouseTimestampAccessClause(): string {
    if (this.accessWindow.kind === "full") return "";
    const activityDate = clickHouseActivityCalendarDate("activity");
    return `
          AND ${activityDate} >= toDate({accessStartDate:String})
          AND ${activityDate} < toDate({accessEndDateExclusive:String})`;
  }

  #clickhouseTimestampAccessParams(): Record<string, string> {
    if (this.accessWindow.kind === "full") return {};
    return {
      accessStartDate: this.accessWindow.startDate,
      accessEndDateExclusive: this.accessWindow.endDateExclusive,
    };
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
