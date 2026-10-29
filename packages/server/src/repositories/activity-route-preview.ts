import { z } from "zod";
import { type MapPreview, routeMapPreview } from "../lib/map-preview.ts";

const routePreviewPointRowSchema = z.object({
  activity_id: z.string(),
  lat: z.coerce.number(),
  lng: z.coerce.number(),
});

export type ActivityRoutePreview = MapPreview;

interface RoutePreviewSensorStore {
  query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<z.infer<TSchema>[]>;
}

const routePreviewMaxPoints = 96;
const activityMapReadinessRowSchema = z.object({
  activity_id: z.string(),
  status: z.enum(["processing", "awaiting_summary", "unavailable"]),
});

export async function getActivityMapReadiness(
  sensorStore: RoutePreviewSensorStore,
  userId: string,
  activities: ReadonlyArray<{
    id: string;
    routeActivityId: string;
    memberActivityIds: readonly string[];
  }>,
): Promise<Map<string, z.infer<typeof activityMapReadinessRowSchema>["status"]>> {
  const members = activities.flatMap((activity) =>
    activity.memberActivityIds.map((memberActivityId) => ({
      activityId: activity.id,
      routeActivityId: activity.routeActivityId,
      memberActivityId,
    })),
  );
  if (members.length === 0) return new Map();

  const rows = await sensorStore.query(
    activityMapReadinessRowSchema,
    `WITH activity_members AS (
      SELECT member.1 AS activity_id, member.2 AS route_activity_id, member.3 AS member_activity_id
      FROM (
        SELECT arrayJoin(arrayZip(
          {activityIds:Array(UUID)}, {routeActivityIds:Array(UUID)}, {memberActivityIds:Array(UUID)}
        )) AS member
      )
    ), source_state AS (
      SELECT activity_members.activity_id AS activity_id,
        activity_members.route_activity_id AS route_activity_id, max(changes.changed_at) AS changed_at
      FROM activity_members
      LEFT JOIN analytics.activity_location_member_change AS changes
        ON changes.member_activity_id = activity_members.member_activity_id
       AND changes.user_id = {userId:UUID}
      GROUP BY activity_members.activity_id, activity_members.route_activity_id
    ), route_state AS (
      SELECT activity_id, max(source_refreshed_at) AS refreshed_at,
        countIf(is_deleted = 0 AND lat IS NOT NULL AND lng IS NOT NULL) AS gps_count
      FROM analytics.activity_location_sample FINAL
      WHERE user_id = {userId:UUID} AND activity_id IN {routeActivityIds:Array(UUID)}
      GROUP BY activity_id
    )
    SELECT toString(source_state.activity_id) AS activity_id,
      multiIf(
        source_state.changed_at > coalesce(route_state.refreshed_at, toDateTime64(0, 9, 'UTC')),
        'processing',
        route_state.gps_count > 0,
        'awaiting_summary',
        'unavailable'
      ) AS status
    FROM source_state
    LEFT JOIN route_state ON route_state.activity_id = source_state.route_activity_id`,
    {
      userId,
      activityIds: members.map((member) => member.activityId),
      routeActivityIds: members.map((member) => member.routeActivityId),
      memberActivityIds: members.map((member) => member.memberActivityId),
    },
  );
  return new Map(rows.map((row) => [row.activity_id, row.status]));
}

export async function getActivityRoutePreviews(
  sensorStore: RoutePreviewSensorStore,
  userId: string,
  activityIds: string[],
): Promise<Map<string, ActivityRoutePreview>> {
  const uniqueActivityIds = [...new Set(activityIds)];
  if (uniqueActivityIds.length === 0) {
    return new Map();
  }

  const rows = await sensorStore.query(
    routePreviewPointRowSchema,
    `WITH route_points AS (
        SELECT
          toString(activity_id) AS activity_id,
          recorded_at,
          lat,
          lng,
          row_number() OVER (PARTITION BY activity_id ORDER BY recorded_at) AS point_index,
          count() OVER (PARTITION BY activity_id) AS point_count
        FROM analytics.activity_location_sample
        WHERE user_id = {userId:UUID}
          AND activity_id IN (
            SELECT arrayJoin(CAST({activityIds:Array(String)}, 'Array(UUID)'))
          )
          AND is_deleted = 0
          AND lat IS NOT NULL
          AND lng IS NOT NULL
      )
      SELECT
        activity_id,
        lat,
        lng
      FROM route_points
      WHERE point_index = 1
        OR point_index = point_count
        OR modulo(
          point_index - 1,
          greatest(1, intDiv(point_count + {maxPoints:UInt64} - 1, {maxPoints:UInt64}))
        ) = 0
      ORDER BY activity_id, recorded_at`,
    { activityIds: uniqueActivityIds, maxPoints: routePreviewMaxPoints, userId },
  );

  const pointsByActivityId = new Map<string, { lat: number; lng: number }[]>();
  for (const row of rows) {
    const points = pointsByActivityId.get(row.activity_id) ?? [];
    points.push({ lat: row.lat, lng: row.lng });
    pointsByActivityId.set(row.activity_id, points);
  }

  return new Map(
    Array.from(pointsByActivityId.entries()).map(([activityId, points]) => [
      activityId,
      routeMapPreview(points),
    ]),
  );
}
