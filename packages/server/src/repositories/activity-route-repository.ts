import { z } from "zod";
import type { ActivitySensorStore, ActivitySensorWindow } from "./activity-repository.ts";

const routeFreshnessSchema = z.object({
  is_processing: z.coerce.number(),
  gps_count: z.coerce.number(),
});

const routePointSchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
});

type ActivityRouteResult =
  | { status: "processing" }
  | { status: "unavailable" }
  | { status: "ready"; points: Array<{ lat: number; lng: number }> };

export async function getActivityRoute(
  sensorStore: Pick<ActivitySensorStore, "query">,
  window: ActivitySensorWindow,
  maxPoints: number,
): Promise<ActivityRouteResult> {
  const [freshness] = await sensorStore.query(
    routeFreshnessSchema,
    `WITH
      source_state AS (
        SELECT max(changed_at) AS changed_at
        FROM analytics.activity_location_member_change
        WHERE user_id = {userId:UUID}
          AND member_activity_id IN (
            SELECT arrayJoin(CAST({memberActivityIds:Array(String)}, 'Array(UUID)'))
          )
      ),
      route_state AS (
        SELECT
          max(source_refreshed_at) AS refreshed_at,
          countIf(is_deleted = 0 AND lat IS NOT NULL AND lng IS NOT NULL) AS gps_count
        FROM analytics.activity_location_sample FINAL
        WHERE user_id = {userId:UUID}
          AND activity_id = {activityId:UUID}
      )
      SELECT
        toUInt8(source_state.changed_at > route_state.refreshed_at) AS is_processing,
        route_state.gps_count AS gps_count
      FROM source_state CROSS JOIN route_state`,
    {
      userId: window.userId,
      activityId: window.activityId,
      memberActivityIds: window.memberActivityIds,
    },
  );

  if (!freshness) {
    throw new Error("Activity route freshness query returned no row");
  }
  if (freshness.is_processing === 1) return { status: "processing" };
  if (freshness.gps_count === 0) return { status: "unavailable" };

  const points = await sensorStore.query(
    routePointSchema,
    `WITH ranked_points AS (
      SELECT
        lat,
        lng,
        row_number() OVER (ORDER BY recorded_at, source_metric_stream_id) AS point_index,
        count() OVER () AS point_count
      FROM analytics.activity_location_sample FINAL
      WHERE user_id = {userId:UUID}
        AND activity_id = {activityId:UUID}
        AND is_deleted = 0
        AND lat IS NOT NULL
        AND lng IS NOT NULL
        AND recorded_at >= parseDateTime64BestEffort({startedAt:String})
        ${window.endedAt ? "AND recorded_at <= parseDateTime64BestEffort({endedAt:String})" : ""}
    )
    SELECT lat, lng
    FROM ranked_points
    WHERE point_index = 1
      OR point_index = point_count
      OR modulo(
        point_index - 1,
        greatest(1, intDiv(point_count + {maxPoints:UInt64} - 1, {maxPoints:UInt64}))
      ) = 0
    ORDER BY point_index`,
    {
      userId: window.userId,
      activityId: window.activityId,
      startedAt: window.startedAt,
      endedAt: window.endedAt,
      maxPoints,
    },
  );

  return points.length > 0 ? { status: "ready", points } : { status: "unavailable" };
}
