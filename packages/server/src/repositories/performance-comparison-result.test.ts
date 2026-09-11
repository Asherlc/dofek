import { describe, expect, it } from "vitest";
import { describeComparisonEvidence, resolveExplicit } from "./performance-comparison-identity.ts";
import {
  buildPerformanceComparisonRows,
  type PerformanceActivityRow,
} from "./performance-comparison-result.ts";
import { evaluateRouteMatch } from "./route-equivalence.ts";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BENCHMARK_ID = "00000000-0000-4000-8000-000000000002";
const FIRST_ID = "00000000-0000-4000-8000-000000000010";
const SECOND_ID = "00000000-0000-4000-8000-000000000020";

function activity(activityId: string): PerformanceActivityRow {
  return {
    activity_id: activityId,
    canonical_type: "cycling",
    activity_name: "Controlled loop",
    modality: "outdoor",
    started_at: "2026-06-01T17:00:00.000Z",
    ended_at: "2026-06-01T17:30:00.000Z",
    local_date: "2026-06-01",
    source_providers: ["garmin"],
    source_external_ids: [],
    member_activity_ids: [activityId],
    timezone: "UTC",
    start_utc_offset_minutes: 0,
    local_time_source: "provider_timezone",
    date_was_authoritative: true,
    source_raw_evidence: [],
    exercise_ids: [],
    climb_identities: [],
  };
}

describe("buildPerformanceComparisonRows", () => {
  it("keeps route and benchmark evidence discriminators aligned with their payloads", () => {
    const first = activity(FIRST_ID);
    const second = activity(SECOND_ID);
    const points = [
      { lat: 37, lng: -122 },
      { lat: 37.01, lng: -122 },
      { lat: 37.02, lng: -122 },
    ];
    const geometry = evaluateRouteMatch({ left: points, right: points });
    if (!geometry?.matched) throw new Error("Expected identical valid route geometry to match");
    const equivalence = resolveExplicit({ kind: "user_defined_benchmark", value: BENCHMARK_ID });

    const { performances } = buildPerformanceComparisonRows({
      pageRows: [first, second],
      baseline: first,
      equivalence,
      identityKind: "user_defined_benchmark",
      identityValue: BENCHMARK_ID,
      matchingIdentitiesByActivity: new Map(),
      routeMatches: [
        {
          activityId: FIRST_ID,
          geometry: null,
          geometry_unavailable_reason: "Route geometry is unavailable.",
          quality: {
            geometry_status: "unavailable",
            coverage_pct: null,
            largest_gap_seconds: null,
          },
          anchor_quality: {
            geometry_status: "available",
            coverage_pct: 100,
            largest_gap_seconds: 1,
          },
          anchor_activity_id: FIRST_ID,
          source_providers: ["garmin"],
          source_devices: ["edge"],
          anchor_source_providers: ["garmin"],
          anchor_source_devices: ["edge"],
        },
        {
          activityId: SECOND_ID,
          geometry,
          geometry_unavailable_reason: null,
          quality: { geometry_status: "available", coverage_pct: 100, largest_gap_seconds: 1 },
          anchor_quality: {
            geometry_status: "available",
            coverage_pct: 100,
            largest_gap_seconds: 1,
          },
          anchor_activity_id: FIRST_ID,
          source_providers: ["wahoo"],
          source_devices: ["bolt"],
          anchor_source_providers: ["garmin"],
          anchor_source_devices: ["edge"],
        },
      ],
      benchmarkRows: [FIRST_ID, SECOND_ID].map((canonicalActivityId) => ({
        canonical_activity_id: canonicalActivityId,
        display_name: "Controlled loop",
        notes: "Same protocol",
        inclusion_note: null,
      })),
      effortRows: [],
      sensorRows: [],
      climbingRows: [],
      strengthRows: [],
      timezone: "UTC",
      evidenceFor: (activityId) => describeComparisonEvidence(equivalence, [], USER_ID, activityId),
    });

    expect(performances[0]?.equivalence_evidence.map(({ evidence_type }) => evidence_type)).toEqual(
      ["user_benchmark_membership"],
    );
    expect(performances[1]?.equivalence_evidence.map(({ evidence_type }) => evidence_type)).toEqual(
      ["route_geometry", "user_benchmark_membership"],
    );
  });
});
