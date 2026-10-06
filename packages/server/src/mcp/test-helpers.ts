import type { ClimbingContext } from "@dofek/training/climbing-context";

export function climbingSessionContext(): ClimbingContext {
  return {
    providerId: "openbeta",
    locationPath: [{ name: "Crag", externalId: "area-1", kind: null }],
    board: { name: "Board", externalId: "board-1" },
    wallAngle: { value: -20, unit: null },
    climbStyle: "top-rope",
    resultStyle: "Fell/Hung",
  };
}
export function climbingSessionDetail(context = climbingSessionContext()) {
  return {
    id: "entry-1",
    climbType: "route" as const,
    gradeSystem: "yds" as const,
    grade: "5.10a",
    sent: false,
    attemptCount: null,
    attempts: [],
    ascentType: null,
    holdType: null,
    routeName: "Corner",
    locationName: "Crag",
    lead: false,
    sourceName: "Mountain Project, OpenBeta",
    wallAngleDegrees: null,
    context,
  };
}
export function climbingSessionResult() {
  const detail = climbingSessionDetail();
  return {
    sessions: [
      {
        activity_id: "activity-1",
        started_at: "2026-09-29T10:00:00Z",
        duration_minutes: null,
        avg_hr: null,
        name: null,
        gym_vs_crag: null,
        location: "Crag",
        total_vertical_m: null,
        climbs: [
          {
            id: detail.id,
            discipline: "top_rope",
            grade: detail.grade,
            grade_system: detail.gradeSystem,
            sent: detail.sent,
            attempt_count: detail.attemptCount,
            attempts: detail.attempts,
            ascent_type: detail.ascentType,
            hold_type: detail.holdType,
            route_name: detail.routeName,
            location_name: detail.locationName,
            source_name: detail.sourceName,
            wall_angle_degrees: detail.wallAngleDegrees,
            context: detail.context,
          },
        ],
      },
    ],
    aggregates: {
      grade_distribution: [
        { discipline: "top_rope", grade: "5.10a", grade_system: "yds", attempts: null, sends: 0 },
      ],
      send_rate: 0,
      max_grade_by_discipline: { boulder: null, route: null },
      volume: { climbs: 1, attempts: null, sends: 0, total_vertical_m: null },
      coverage: {
        entries: 1,
        entries_with_attempts: 0,
        entries_with_observed_outcome: 1,
        attempt_data: "unavailable",
      },
    },
  };
}
