import type { ActivityLocation } from "../contracts/activity-location.ts";
import { routeMapPreview } from "../lib/map-preview.ts";
import {
  type ActivitySummaryFormColumns,
  activitySummaryReadModelRowSchema,
} from "./activity-repository-schemas.ts";
import { getActivityMapReadiness, getActivityRoutePreviews } from "./activity-route-preview.ts";
import type { ActivitySensorReadStore } from "./activity-sensor-types.ts";

export async function withActivitySummaries<
  TRow extends {
    id: string;
    member_activity_ids: string[];
    provider_absent_at?: string | null;
  },
>(
  rows: TRow[],
  sensorStore: ActivitySensorReadStore | undefined,
  userId: string,
  options: { includeRunningForm?: boolean } = {},
): Promise<Array<TRow & { location: ActivityLocation | null } & ActivitySummaryFormColumns>> {
  if (!sensorStore) return rows.map((row) => ({ ...row, location: null }));
  if (rows.length === 0) return [];

  const activityIds = [...new Set(rows.map((row) => row.id))];
  const [summaries, routePreviewByActivityId] = await Promise.all([
    options.includeRunningForm
      ? sensorStore.getActivitySummaries(activityIds, options)
      : sensorStore.getActivitySummaries(activityIds),
    getActivityRoutePreviews(sensorStore, userId, activityIds),
  ]);
  const summaryByActivityId = new Map(
    summaries.map((summary) => [
      summary.activity_id,
      activitySummaryReadModelRowSchema.parse(summary),
    ]),
  );
  const mapReadinessByActivityId = await getActivityMapReadiness(
    sensorStore,
    userId,
    rows
      .filter((row) => {
        const summary = summaryByActivityId.get(row.id);
        return summary?.centroid_lat == null || summary.centroid_lng == null;
      })
      .map((row) => ({
        id: row.id,
        routeActivityId: row.id,
        memberActivityIds: row.member_activity_ids,
      })),
  );
  return rows.map((row) => {
    const summary = summaryByActivityId.get(row.id);
    const mapReadiness = mapReadinessByActivityId.get(row.id);
    const pendingLocation: ActivityLocation | null =
      mapReadiness === "processing" ||
      (mapReadiness === "awaiting_summary" && row.provider_absent_at == null)
        ? { kind: "processing" }
        : null;
    if (!summary) return { ...row, location: pendingLocation };
    const routePreview = routePreviewByActivityId.get(summary.activity_id);
    return {
      ...row,
      avg_hr: summary.avg_hr,
      max_hr: summary.max_hr,
      avg_power: summary.avg_power,
      max_power: summary.max_power,
      avg_speed: summary.avg_speed,
      max_speed: summary.max_speed,
      avg_cadence: summary.avg_cadence,
      ...(options.includeRunningForm
        ? {
            cadence_basis: summary.cadence_basis ?? null,
            cadence_observed_seconds: summary.cadence_observed_seconds ?? null,
            cadence_coverage_percent: summary.cadence_coverage_percent ?? null,
            avg_stride_length: summary.avg_stride_length ?? null,
            avg_stance_time: summary.avg_stance_time ?? null,
            avg_vertical_osc: summary.avg_vertical_osc ?? null,
          }
        : {}),
      total_distance: summary.total_distance,
      distance_meters: summary.total_distance,
      elevation_gain_m: summary.elevation_gain_m,
      elevation_loss_m: summary.elevation_loss_m,
      sample_count: summary.sample_count,
      location:
        summary.centroid_lat != null && summary.centroid_lng != null
          ? {
              kind: "recorded_gps" as const,
              centroidLat: summary.centroid_lat,
              centroidLng: summary.centroid_lng,
              mapPreview:
                routePreview ??
                routeMapPreview([{ lat: summary.centroid_lat, lng: summary.centroid_lng }]),
            }
          : pendingLocation,
    };
  });
}
