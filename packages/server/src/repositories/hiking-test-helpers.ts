export const firstHikingActivityId = "00000000-0000-4000-8000-000000000001";
export const secondHikingActivityId = "00000000-0000-4000-8000-000000000002";

/** A complete serving-projection row for route comparison query fixtures. */
export function hikingComparisonRow(overrides: Record<string, unknown> = {}) {
  return {
    canonical_activity_id: firstHikingActivityId,
    canonical_type: "hiking",
    modality: null,
    activity_name: "Trail Loop",
    started_at: "2026-10-27T08:00:00Z",
    date: "2026-10-27",
    distance_m: 5000,
    duration_minutes: 60,
    average_pace_min_per_km: 12,
    avg_heart_rate: 145,
    elevation_gain_m: 200,
    points: [
      [37.77, -122.42],
      [37.785, -122.42],
      [37.8, -122.42],
      [37.815, -122.42],
    ],
    route_distance_meters: 5000,
    elevation_profile: [],
    geometry_status: "available",
    coverage_pct: 100,
    largest_gap_seconds: 10,
    ...overrides,
  };
}
