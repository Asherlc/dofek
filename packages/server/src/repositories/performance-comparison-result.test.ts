import { describe, expect, it } from "vitest";
import { describeComparisonEvidence, resolveExplicit } from "./performance-comparison-identity.ts";
import {
  buildPerformanceComparisonRows,
  type PerformanceActivityRow,
  performanceDurationSeconds,
} from "./performance-comparison-result.ts";
import { evaluateRouteMatch } from "./route-equivalence.ts";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BENCHMARK_ID = "00000000-0000-4000-8000-000000000002";
const FIRST_ID = "00000000-0000-4000-8000-000000000010";
const SECOND_ID = "00000000-0000-4000-8000-000000000020";

function activity(
  activityId: string,
  overrides: Partial<PerformanceActivityRow> = {},
): PerformanceActivityRow {
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
    ...overrides,
  };
}

type ComparisonRowsInput = Parameters<typeof buildPerformanceComparisonRows>[0];

function comparisonInput(
  pageRows: PerformanceActivityRow[],
  overrides: Partial<ComparisonRowsInput> = {},
): ComparisonRowsInput {
  const baseline = overrides.baseline ?? pageRows[0];
  if (!baseline) throw new Error("Expected a baseline fixture");
  const equivalence =
    overrides.equivalence ??
    resolveExplicit({ kind: "user_defined_benchmark", value: BENCHMARK_ID });
  return {
    pageRows,
    baseline,
    equivalence,
    identityKind: "user_defined_benchmark",
    identityValue: BENCHMARK_ID,
    matchingIdentitiesByActivity: new Map(),
    routeMatches: [],
    benchmarkRows: [],
    effortRows: [],
    sensorRows: [],
    climbingRows: [],
    strengthRows: [],
    timezone: "UTC",
    evidenceFor: (activityId) => describeComparisonEvidence(equivalence, [], USER_ID, activityId),
    ...overrides,
  };
}

describe("buildPerformanceComparisonRows", () => {
  it("preserves duration boundaries and null delta semantics", () => {
    const complete = activity(FIRST_ID);
    const missing = activity(SECOND_ID, { ended_at: null });
    const invalid = activity(SECOND_ID, { started_at: "invalid" });
    const zero = activity(SECOND_ID, { ended_at: "2026-06-01T17:00:00.000Z" });

    expect(performanceDurationSeconds(complete)).toBe(1800);
    expect(performanceDurationSeconds(missing)).toBeNull();
    expect(performanceDurationSeconds(invalid)).toBeNull();
    expect(performanceDurationSeconds(zero)).toBe(0);

    const missingCandidate = buildPerformanceComparisonRows(
      comparisonInput([missing], { baseline: complete }),
    ).performances[0];
    const missingBaseline = buildPerformanceComparisonRows(
      comparisonInput([complete], { baseline: missing }),
    ).performances[0];
    expect(missingCandidate?.delta_to_baseline.duration_seconds).toBeNull();
    expect(missingBaseline?.delta_to_baseline.duration_seconds).toBeNull();
  });

  it("computes climbing and strength deltas from complete observations", () => {
    const first = activity(FIRST_ID, { canonical_type: "strength" });
    const second = activity(SECOND_ID, { canonical_type: "strength" });
    const climbingRows = [
      { activityId: FIRST_ID, entryId: "00000000-0000-4000-8000-000000000101", attempts: 2 },
      { activityId: SECOND_ID, entryId: "00000000-0000-4000-8000-000000000102", attempts: 3 },
    ].map(({ activityId, entryId, attempts }) => ({
      activity_id: activityId,
      entry_id: entryId,
      entry_activity_id: activityId,
      entry_provider: "kaya",
      external_id: entryId,
      climb_type: "boulder",
      grade_system: "v_scale",
      grade: "V6",
      sent: true,
      attempt_count: attempts,
      lead: null,
      wall_angle_degrees: null,
      route_name: "Blue Arete",
      location_name: "The Gym",
    }));
    const strengthRows = [
      { activityId: FIRST_ID, setId: "00000000-0000-4000-8000-000000000201", weight: 100 },
      { activityId: SECOND_ID, setId: "00000000-0000-4000-8000-000000000202", weight: 110 },
    ].map(({ activityId, setId, weight }) => ({
      activity_id: activityId,
      set_id: setId,
      set_activity_id: activityId,
      set_provider: "hevy",
      exercise_id: BENCHMARK_ID,
      exercise_index: 0,
      set_index: 0,
      set_type: "working",
      weight_kg: weight,
      reps: 5,
      rpe: 8,
    }));

    const { performances } = buildPerformanceComparisonRows(
      comparisonInput([first, second], { climbingRows, strengthRows }),
    );

    expect(performances[1]?.delta_to_baseline).toMatchObject({
      climbing_attempts: 1,
      climbing_sends: 0,
      strength_volume_kg_reps: 50,
      strength_estimated_one_rep_max_kg: expect.closeTo(11.66, 2),
    });
  });

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
    expect(performances[1]?.equivalence_evidence[1]?.assertion_evidence).toMatchObject({
      canonical_activity_id: SECOND_ID,
    });
  });
});
