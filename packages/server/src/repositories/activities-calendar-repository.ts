import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { TrainingStressCalculator } from "@dofek/training/training-load";
import type { Database } from "dofek/db";
import type { z } from "zod";
import { loadClimbingGradePreference } from "../climbing-grade-preferences.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { mergeDayGroups } from "./activity-calendar-day-groups.ts";
import {
  activityRowSchema,
  baselineRowSchema,
  type CalendarActivityEntry,
  type CalendarDayActivities,
  createActiveCalendarEntry,
  type WeekListInput,
} from "./activity-calendar-entry.ts";
import { clickHouseActivityCalendarDate } from "./activity-local-date.ts";
import { type ActivitySensorStore, activityRepositoryFor } from "./activity-repository.ts";
import { getActivityMapReadiness, getActivityRoutePreviews } from "./activity-route-preview.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";
import { ProviderAbsentActivitiesCalendarRepository } from "./provider-absent-activities-calendar-repository.ts";

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

    const hiddenDays = await new ProviderAbsentActivitiesCalendarRepository(
      this.db,
      this.userId,
      this.timezone,
      this.#sensorStore,
      this.accessWindow,
    ).getWeekList(input);
    return mergeDayGroups(activeDays, hiddenDays);
  }

  async #getActiveWeekList(input: WeekListInput): Promise<CalendarDayActivities[]> {
    const days = input.weeks * 7;
    const windowStart = dateWindowStartString(input.endDate, days);
    const activityTypeFilter = input.activityType
      ? "AND activity.canonical_type = {activityType:String}"
      : "";
    const queryParams = {
      userId: this.userId,
      timezone: this.timezone,
      windowStart,
      ...(input.activityType ? { activityType: input.activityType } : {}),
    };
    const activityDate = clickHouseActivityCalendarDate("activity");

    const [activityRows, baselineRows] = await Promise.all([
      this.#sensorStore.query(
        activityRowSchema,
        `SELECT
            toString(activity.activity_id) AS id,
            activity.name AS name,
            activity.canonical_type AS canonical_type,
            activity.modality AS modality,
            toString(activity.started_at) AS started_at,
            toString(activity.ended_at) AS ended_at,
            activity.provider_id AS provider_id,
            activity.source_name AS source_name,
            activity.member_activity_ids AS member_activity_ids,
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
            toString(${activityDate}) AS local_date
          FROM analytics.deduped_activities AS activity FINAL
          LEFT JOIN analytics.activity_summary asum
            ON asum.user_id = activity.user_id
           AND asum.activity_id = activity.activity_id
          WHERE activity.user_id = {userId:UUID}
            AND activity.is_deleted = 0
            AND activity.ended_at IS NOT NULL
            AND ${activityDate} >= toDate({windowStart:String})
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
    ).filterToVisibleCanonicalActivities(activityRowsMatchingType);
    const locationActivityIds = filteredActivityRows
      .filter((row) => row.centroid_lat != null && row.centroid_lng != null)
      .map((row) => row.id);
    const sourceActivityIds = filteredActivityRows
      .filter((row) => row.centroid_lat == null || row.centroid_lng == null)
      .map((row) => row.id);
    const [routePreviewByActivityId, sourceLocationsByActivityId] = await Promise.all([
      getActivityRoutePreviews(this.#sensorStore, this.userId, locationActivityIds),
      sourceActivityIds.length
        ? loadClimbingGradePreference(this.db, this.userId).then((preference) =>
            new ClimbingActivityLogEntryRepository(
              this.db,
              this.userId,
              this.timezone,
              this.accessWindow,
              preference,
            ).getActivityMapLocations(sourceActivityIds),
          )
        : Promise.resolve(new Map<string, ClimbingMapLocation[]>()),
    ]);

    const baseline = baselineRows[0] ?? { max_hr: null, resting_hr: null, ftp: null };
    const mapReadinessByActivityId = await getActivityMapReadiness(
      this.#sensorStore,
      this.userId,
      filteredActivityRows
        .filter(
          (row) =>
            (row.centroid_lat == null || row.centroid_lng == null) &&
            !sourceLocationsByActivityId.get(row.id)?.length,
        )
        .map((row) => ({
          id: row.id,
          routeActivityId: row.id,
          memberActivityIds: row.member_activity_ids,
        })),
    );
    const calculator = new TrainingStressCalculator();

    const dayMap = new Map<string, CalendarActivityEntry[]>();
    for (const row of filteredActivityRows) {
      const entry = createActiveCalendarEntry(row, {
        baseline,
        calculator,
        routePreview: routePreviewByActivityId.get(row.id),
        sourceLocations: sourceLocationsByActivityId.get(row.id),
        mapReadiness: mapReadinessByActivityId.get(row.id),
      });

      const bucket = dayMap.get(row.local_date) ?? [];
      bucket.push(entry);
      dayMap.set(row.local_date, bucket);
    }

    return Array.from(dayMap.entries())
      .map(([date, activities]) => ({ date, activities }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }
}

function filterActivityRowsByType(
  activityRows: z.infer<typeof activityRowSchema>[],
  activityType: string | undefined,
) {
  return activityType
    ? activityRows.filter((activityRow) => activityRow.canonical_type === activityType)
    : activityRows;
}
