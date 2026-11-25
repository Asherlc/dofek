import { activityAgendaPlannedWindow } from "@dofek/format/activity-agenda";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import type { Database } from "dofek/db";
import type { z } from "zod";
import { loadClimbingGradePreference } from "../climbing-grade-preferences.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { mergeDayGroups } from "./activity-calendar-day-groups.ts";
import {
  type ActivityListPage,
  activityRowSchema,
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

/** Per-activity calendar data with route summaries. */
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
    const { rows } = await this.#getActiveRows(input);
    const activeDays = await this.#getActiveDayGroups(rows);
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

  async findByIds(activityIds: string[], activityType?: string) {
    if (activityIds.length === 0) return [];
    const { rows } = await this.#getActiveRows({ activityIds, activityType });
    const days = await this.#getActiveDayGroups(rows);
    return days.flatMap(({ date, activities }) =>
      activities.map((activity) => ({ ...activity, date })),
    );
  }

  async getPage(
    input: WeekListInput & { page: number; pageSize: number },
  ): Promise<ActivityListPage> {
    const hiddenRepository = new ProviderAbsentActivitiesCalendarRepository(
      this.db,
      this.userId,
      this.timezone,
      this.#sensorStore,
      this.accessWindow,
    );
    const [{ rows }, hiddenRows] = await Promise.all([
      this.#getActiveRows(input),
      input.includeProviderAbsent ? hiddenRepository.getRows(input) : Promise.resolve([]),
    ]);
    const candidates = new Map<string, { row: z.infer<typeof activityRowSchema>; hidden: boolean }>(
      [...rows.map((row) => [row.id, { row, hidden: false }] as const)],
    );
    for (const row of hiddenRows) {
      if (!candidates.has(row.id)) candidates.set(row.id, { row, hidden: true });
    }
    const dateOrder = input.dateOrder ?? "newest";
    const ordered = [...candidates.values()].sort((left, right) => {
      const dateCmp =
        dateOrder === "oldest"
          ? left.row.local_date.localeCompare(right.row.local_date)
          : right.row.local_date.localeCompare(left.row.local_date);
      if (dateCmp !== 0) return dateCmp;
      // Within a day keep newest-time ordering for both agenda date orders.
      return (
        right.row.started_at.localeCompare(left.row.started_at) ||
        left.row.id.localeCompare(right.row.id)
      );
    });
    const totalCount = ordered.length;
    const page = Math.min(input.page, Math.max(0, Math.ceil(totalCount / input.pageSize) - 1));
    const selected = ordered.slice(page * input.pageSize, (page + 1) * input.pageSize);
    const selectedIds = new Set(selected.map((entry) => entry.row.id));
    const hiddenIds = new Set(
      selected.filter((entry) => entry.hidden).map((entry) => entry.row.id),
    );
    const [activeDays, hiddenDays] = await Promise.all([
      this.#getActiveDayGroups(rows.filter((row) => selectedIds.has(row.id))),
      hiddenRepository.getDayGroups(hiddenRows.filter((row) => hiddenIds.has(row.id))),
    ]);
    const days = mergeDayGroups(activeDays, hiddenDays);
    days.sort((left, right) =>
      dateOrder === "oldest"
        ? left.date.localeCompare(right.date)
        : right.date.localeCompare(left.date),
    );
    for (const day of days) {
      day.activities.sort(
        (left, right) =>
          right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id),
      );
    }
    const result: ActivityListPage = { days, totalCount, page, pageSize: input.pageSize };
    if (input.startDate) {
      const hasLaterPage = (page + 1) * input.pageSize < totalCount;
      const previousPageLastActivityDate =
        page > 0 ? ordered[page * input.pageSize - 1]?.row.local_date : undefined;
      result.plannedWindow = activityAgendaPlannedWindow({
        rangeStart: input.startDate,
        rangeEnd: input.endDate,
        pageActivityDates: selected.map((entry) => entry.row.local_date),
        hasLaterPage,
        previousPageLastActivityDate,
        dateOrder,
      });
    }
    return result;
  }

  async #getActiveRows(input: WeekListInput | { activityIds: string[]; activityType?: string }) {
    const activityTypeFilter = input.activityType
      ? "AND coalesce(activity.primary_canonical_type, activity.canonical_type) = {activityType:String}"
      : "";
    const explicitStartDate = !("activityIds" in input) ? input.startDate : undefined;
    const queryParams = {
      userId: this.userId,
      timezone: this.timezone,
      ...("activityIds" in input
        ? { activityIds: input.activityIds }
        : explicitStartDate
          ? { windowStart: explicitStartDate, windowEnd: input.endDate }
          : { windowStart: dateWindowStartString(input.endDate, input.weeks * 7) }),
      ...(input.activityType ? { activityType: input.activityType } : {}),
    };
    const activityDate = clickHouseActivityCalendarDate("activity");
    const dateBounds =
      "activityIds" in input
        ? "AND activity.activity_id IN {activityIds:Array(UUID)}"
        : explicitStartDate
          ? `AND ${activityDate} >= toDate({windowStart:String})
            AND ${activityDate} <= toDate({windowEnd:String})`
          : `AND ${activityDate} >= toDate({windowStart:String})`;

    const activityRows = await this.#sensorStore.query(
      activityRowSchema,
      `SELECT
            toString(activity.activity_id) AS id,
            activity.name AS name,
            activity.canonical_type AS canonical_type,
            activity.primary_canonical_type AS primary_canonical_type,
            activity.modality AS modality,
            toString(activity.started_at) AS started_at,
            toString(activity.ended_at) AS ended_at,
            activity.provider_id AS provider_id,
            toString(activity.primary_activity_id) AS primary_activity_id,
            activity.primary_provider_id AS primary_provider_id,
            activity.primary_source_name AS primary_source_name,
            arrayMap(member -> toString(member), activity.origin_candidate_member_ids) AS origin_candidate_member_ids,
            activity.origin_evidence AS origin_evidence,
            activity.source_name AS source_name,
            activity.member_activity_ids AS member_activity_ids,
            activity.timezone AS timezone,
            activity.start_utc_offset_minutes AS start_utc_offset_minutes,
            activity.end_utc_offset_minutes AS end_utc_offset_minutes,
            activity.local_time_source AS local_time_source,
            dateDiff('millisecond', activity.started_at, activity.ended_at) / 60000.0 AS duration_min,
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
            AND (activity.ended_at IS NOT NULL OR activity.provider_type = 'climbing_log')
            ${dateBounds}
            ${activityTypeFilter}
          ORDER BY activity.started_at DESC`,
      queryParams,
    );

    const activityRowsMatchingType = filterActivityRowsByType(activityRows, input.activityType);
    const filteredActivityRows = await activityRepositoryFor(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).filterToVisibleCanonicalActivities(activityRowsMatchingType);
    return { rows: filteredActivityRows };
  }

  async #getActiveDayGroups(
    filteredActivityRows: z.infer<typeof activityRowSchema>[],
  ): Promise<CalendarDayActivities[]> {
    const locationActivityIds = filteredActivityRows
      .filter((row) => row.centroid_lat != null && row.centroid_lng != null)
      .map((row) => row.id);
    const sourceActivityIds = filteredActivityRows
      .filter((row) => row.centroid_lat == null || row.centroid_lng == null)
      .map((row) => row.id);
    const [routePreviewByActivityId, sourceLocationsByActivityId, sourceSessionsByActivityId] =
      await Promise.all([
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
        new ClimbingActivityLogEntryRepository(
          this.db,
          this.userId,
          this.timezone,
          this.accessWindow,
        ).getActivityLogSessions(filteredActivityRows.map((row) => row.id)),
      ]);

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

    const dayMap = new Map<string, CalendarActivityEntry[]>();
    for (const row of filteredActivityRows) {
      const entry = createActiveCalendarEntry(row, {
        routePreview: routePreviewByActivityId.get(row.id),
        sourceLocations: sourceLocationsByActivityId.get(row.id),
        mapReadiness: mapReadinessByActivityId.get(row.id),
        climbingLogSessions: sourceSessionsByActivityId.get(row.id),
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
    ? activityRows.filter(
        (activityRow) =>
          (activityRow.primary_canonical_type ?? activityRow.canonical_type) === activityType,
      )
    : activityRows;
}
