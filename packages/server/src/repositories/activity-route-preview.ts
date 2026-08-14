import { z } from "zod";
import { type OsmTilePreview, osmTilePreview } from "../lib/osm-tile.ts";

const routePreviewPointRowSchema = z.object({
  activity_id: z.string(),
  lat: z.coerce.number(),
  lng: z.coerce.number(),
});

export type ActivityRoutePreview = OsmTilePreview;

interface RoutePreviewSensorStore {
  query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<z.infer<TSchema>[]>;
}

const routePreviewMaxPoints = 96;

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
      osmTilePreview(points),
    ]),
  );
}
