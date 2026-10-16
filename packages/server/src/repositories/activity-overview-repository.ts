import type { ActivityDataState } from "@dofek/format/activity-data-state";
import type {
  ActivityOverviewChange,
  ActivityOverviewChangeTrend,
  ActivityOverviewComparison,
  ActivityOverviewMeasurementChange,
} from "@dofek/format/activity-overview";
import type { Database } from "dofek/db";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowEndExclusiveString, dateWindowStartString } from "../lib/date-window.ts";
import type { WeekListInput } from "./activity-calendar-entry.ts";
import { clickHouseActivityCalendarDate } from "./activity-local-date.ts";
import { type ActivitySensorStore, activityRepositoryFor } from "./activity-repository.ts";

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
  canonical_type: z.string(),
});

export class ActivityOverviewRepository extends BaseRepository {
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

  async getActivityOverview(input: WeekListInput): Promise<ActivityOverview> {
    const activityDate = clickHouseActivityCalendarDate("activity");
    const days = input.weeks * 7;
    const currentWindowStart = dateWindowStartString(input.endDate, days - 1);
    const previousWindowStart = dateWindowStartString(input.endDate, days * 2 - 1);
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

    const activityTypeFilter = input.activityType
      ? "AND activity.canonical_type = {activityType:String}"
      : "";
    const queryParams = {
      userId: this.userId,
      timezone: this.timezone,
      previousWindowStart,
      ...(input.activityType ? { activityType: input.activityType } : {}),
      currentWindowStart,
      endDateExclusive,
      activityIds: visibleActivityIds,
    };
    const typeQueryParams = {
      userId: this.userId,
      timezone: this.timezone,
      currentWindowStart,
      endDateExclusive,
      activityIds: currentVisibleActivityIds,
    };
    const [overviewRows, activityTypeRows] = await Promise.all([
      this.#sensorStore.query(
        overviewRowSchema,
        `WITH ${activityDate} AS activity_date
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
              activity_date >= toDate({previousWindowStart:String})
              AND activity_date < toDate({currentWindowStart:String})
            ) AS previous_activity_count,
            coalesce(
              sumIf(
                dateDiff('second', activity.started_at, activity.ended_at) / 60.0,
                activity_date >= toDate({previousWindowStart:String})
                AND activity_date < toDate({currentWindowStart:String})
              ),
              0
            ) AS previous_total_minutes,
            sumOrNullIf(
              summary.total_distance,
              activity_date >= toDate({previousWindowStart:String})
              AND activity_date < toDate({currentWindowStart:String})
            ) AS previous_total_distance_meters,
            sumOrNullIf(
              summary.elevation_gain_m,
              activity_date >= toDate({previousWindowStart:String})
              AND activity_date < toDate({currentWindowStart:String})
            ) AS previous_total_elevation_gain_m,
            countIf(
              activity_date >= toDate({previousWindowStart:String})
              AND activity_date < toDate({currentWindowStart:String})
              AND summary.total_distance IS NOT NULL
            ) AS previous_distance_measurement_count,
            countIf(
              activity_date >= toDate({previousWindowStart:String})
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
            AND activity_date >= toDate({previousWindowStart:String})
            AND activity_date < toDate({endDateExclusive:String})
            ${activityTypeFilter}`,
        queryParams,
      ),
      this.#sensorStore.query(
        activityTypeRowSchema,
        `WITH ${activityDate} AS activity_date
          SELECT DISTINCT
            activity.canonical_type AS canonical_type
          FROM analytics.deduped_activities AS activity FINAL
          WHERE activity.user_id = {userId:UUID}
            AND activity.activity_id IN {activityIds:Array(UUID)}
            AND activity.is_deleted = 0
            AND activity.ended_at IS NOT NULL
            AND activity_date >= toDate({currentWindowStart:String})
            AND activity_date < toDate({endDateExclusive:String})
          ORDER BY canonical_type ASC`,
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
      activityTypeRows.map((row) => row.canonical_type),
      input.weeks,
    );
  }
}

type AvailableActivityOverviewMeasurement = {
  value: number;
  state: { status: "available" };
};

type UnavailableActivityOverviewMeasurement = {
  value: null;
  state: Exclude<ActivityDataState, { status: "available" }>;
};

type ActivityOverviewMeasurement =
  | AvailableActivityOverviewMeasurement
  | UnavailableActivityOverviewMeasurement;

interface ActivityOverviewPeriod {
  activityCount: number;
  totalMinutes: number;
  totalDistance: ActivityOverviewMeasurement;
  totalElevation: ActivityOverviewMeasurement;
}

function emptyActivityOverviewPeriod(): ActivityOverviewPeriod {
  return {
    activityCount: 0,
    totalMinutes: 0,
    totalDistance: overviewMeasurement("Distance", 0, true),
    totalElevation: overviewMeasurement("Elevation gain", 0, true),
  };
}

function overviewMeasurement(
  label: string,
  value: number | null,
  isAvailable: boolean,
): ActivityOverviewMeasurement {
  if (!isAvailable) {
    return {
      value: null,
      state: {
        status: "missing",
        reason: `${label} was not recorded for every activity.`,
      },
    };
  }
  if (value == null) {
    return {
      value: null,
      state: { status: "missing", reason: `${label} not recorded` },
    };
  }
  return { value, state: { status: "available" } };
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
  const distanceHasMeasurement = distanceMeasurementCount > 0;
  const elevationHasMeasurement = elevationMeasurementCount > 0;
  const distanceValue =
    activityCount === 0
      ? 0
      : distanceHasMeasurement
        ? roundNullableMetric(totalDistanceMeters)
        : null;
  const elevationValue =
    activityCount === 0
      ? 0
      : elevationHasMeasurement
        ? roundNullableMetric(totalElevationGainM)
        : null;

  return {
    activityCount,
    totalMinutes,
    totalDistance: overviewMeasurement(
      "Distance",
      distanceValue,
      distanceHasMeasurement || activityCount === 0,
    ),
    totalElevation: overviewMeasurement(
      "Elevation gain",
      elevationValue,
      elevationHasMeasurement || activityCount === 0,
    ),
  };
}

function createActivityOverview(
  current: ActivityOverviewPeriod,
  previous: ActivityOverviewPeriod,
  activityTypes: string[],
  weeks: number,
): ActivityOverview {
  return {
    activityCount: current.activityCount,
    totalMinutes: current.totalMinutes,
    totalDistanceMeters: current.totalDistance.value,
    totalDistanceState: current.totalDistance.state,
    totalElevationGainM: current.totalElevation.value,
    totalElevationState: current.totalElevation.state,
    activityTypes,
    comparison: {
      periodLabel: `previous ${weeks} ${weeks === 1 ? "week" : "weeks"}`,
      activityCount: createChange(current.activityCount, previous.activityCount, 0),
      totalMinutes: createChange(current.totalMinutes, previous.totalMinutes, 1),
      totalDistanceMeters: createMeasurementChange(current.totalDistance, previous.totalDistance),
      totalElevationGainM: createMeasurementChange(current.totalElevation, previous.totalElevation),
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

function isAvailableMeasurement(
  measurement: ActivityOverviewMeasurement,
): measurement is AvailableActivityOverviewMeasurement {
  return measurement.state.status === "available";
}

function createMeasurementChange(
  current: ActivityOverviewMeasurement,
  previous: ActivityOverviewMeasurement,
): ActivityOverviewMeasurementChange {
  if (!isAvailableMeasurement(current)) {
    return { magnitude: null, trend: "unavailable", state: current.state };
  }
  if (!isAvailableMeasurement(previous)) {
    return {
      magnitude: null,
      trend: "unavailable",
      state: {
        status: previous.state.status,
        reason: `Previous period: ${previous.state.reason}`,
      },
    };
  }

  const difference = roundMetric(current.value - previous.value, 1);
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
