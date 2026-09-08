import { describe, expect, it } from "vitest";
import {
  type ClimbingComparisonRow,
  computeClimbingComparisonMetrics,
  computeStrengthComparisonMetrics,
  type StrengthComparisonRow,
} from "./performance-comparison-modality-metrics.ts";

const CANONICAL_ACTIVITY_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_ACTIVITY_A = "00000000-0000-4000-8000-000000000011";
const SOURCE_ACTIVITY_B = "00000000-0000-4000-8000-000000000012";
const EXERCISE_ID = "00000000-0000-4000-8000-000000000021";

function strengthRow(overrides: Partial<StrengthComparisonRow> = {}): StrengthComparisonRow {
  return {
    activity_id: CANONICAL_ACTIVITY_ID,
    set_id: "00000000-0000-4000-8000-000000000031",
    set_activity_id: SOURCE_ACTIVITY_A,
    set_provider: "hevy",
    exercise_id: EXERCISE_ID,
    exercise_index: 0,
    set_index: 0,
    set_type: "working",
    weight_kg: 100,
    reps: 5,
    rpe: 8,
    ...overrides,
  };
}

function climbingRow(overrides: Partial<ClimbingComparisonRow> = {}): ClimbingComparisonRow {
  return {
    activity_id: CANONICAL_ACTIVITY_ID,
    entry_id: "00000000-0000-4000-8000-000000000041",
    entry_activity_id: SOURCE_ACTIVITY_A,
    entry_provider: "kaya",
    external_id: "problem-1",
    climb_type: "boulder",
    grade_system: "v_scale",
    grade: "V6",
    sent: true,
    attempt_count: 2,
    lead: null,
    wall_angle_degrees: 30,
    route_name: "Blue Arete",
    location_name: "The Gym",
    ...overrides,
  };
}

describe("computeStrengthComparisonMetrics", () => {
  it("returns no metrics when no strength observations exist", () => {
    expect(computeStrengthComparisonMetrics([])).toBeNull();
  });

  it("merges exact duplicates from distinct source activities", () => {
    const result = computeStrengthComparisonMetrics([
      strengthRow(),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000032",
        set_activity_id: SOURCE_ACTIVITY_B,
        set_provider: "strong",
      }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      source_sets: 2,
      sets: 1,
      valid_volume_sets: 1,
      valid_volume_kg_reps: 500,
      suspicious_sets: 0,
      excluded_sets: 0,
      working_sets: 1,
      missing_volume_sets: 0,
      volume_status: "complete",
      estimated_one_rep_max_status: "complete",
    });
  });

  it("excludes conflicting cross-provider versions of the same logical set", () => {
    const result = computeStrengthComparisonMetrics([
      strengthRow(),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000032",
        set_activity_id: SOURCE_ACTIVITY_B,
        set_provider: "strong",
        reps: 8,
      }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      source_sets: 2,
      sets: 2,
      valid_volume_sets: 0,
      valid_volume_kg_reps: null,
      best_estimated_one_rep_max_kg: null,
      suspicious_sets: 2,
      excluded_sets: 2,
      working_sets: 2,
      missing_volume_sets: 0,
      volume_status: "unavailable",
      estimated_one_rep_max_status: "unavailable",
    });
  });

  it("preserves repeated sets recorded by one source", () => {
    const result = computeStrengthComparisonMetrics([
      strengthRow(),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000032",
        set_index: 1,
      }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({ sets: 2, valid_volume_sets: 2, valid_volume_kg_reps: 1000 });
  });

  it("excludes conflicting rows that reuse one source set identity", () => {
    const result = computeStrengthComparisonMetrics([
      strengthRow(),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000032",
        reps: 6,
      }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      source_sets: 2,
      sets: 2,
      valid_volume_sets: 0,
      suspicious_sets: 2,
      excluded_sets: 2,
      volume_status: "unavailable",
    });
  });

  it("excludes ambiguous cross-provider exercise occurrences", () => {
    const result = computeStrengthComparisonMetrics([
      strengthRow(),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000032",
        exercise_index: 1,
      }),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000033",
        set_activity_id: SOURCE_ACTIVITY_B,
        set_provider: "strong",
      }),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000034",
        set_activity_id: SOURCE_ACTIVITY_B,
        set_provider: "strong",
        exercise_index: 1,
      }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      source_sets: 4,
      sets: 4,
      valid_volume_sets: 0,
      suspicious_sets: 4,
      excluded_sets: 4,
      volume_status: "unavailable",
    });
  });

  it("labels a subtotal partial when a working set is missing load or reps", () => {
    const result = computeStrengthComparisonMetrics([
      strengthRow(),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000032",
        set_index: 1,
        weight_kg: null,
      }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      working_sets: 2,
      valid_volume_sets: 1,
      missing_volume_sets: 1,
      valid_volume_kg_reps: 500,
      volume_status: "partial",
      best_estimated_one_rep_max_kg: expect.any(Number),
      estimated_one_rep_max_status: "partial",
      excluded_sets: 1,
    });
  });

  it("flags every invalid strength boundary without contaminating valid volume", () => {
    const result = computeStrengthComparisonMetrics([
      strengthRow({ set_index: 0, set_type: null, reps: 0, weight_kg: 0, rpe: -1 }),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000032",
        set_index: 1,
        reps: 101,
        weight_kg: 100,
        rpe: 11,
      }),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000033",
        set_index: 2,
        reps: 1,
        weight_kg: 501,
        rpe: 10,
      }),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000034",
        set_index: 3,
        set_type: "warmup",
        reps: 0,
        weight_kg: 0,
        rpe: 0,
      }),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000035",
        set_index: 4,
        set_type: "dropset",
        reps: 12,
        weight_kg: 80,
        rpe: 9.5,
      }),
      strengthRow({
        set_id: "00000000-0000-4000-8000-000000000036",
        set_index: 5,
        set_type: "failure",
        reps: 13,
        weight_kg: 70,
        rpe: null,
      }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toEqual({
      source_sets: 6,
      sets: 6,
      working_sets: 4,
      valid_volume_sets: 2,
      missing_volume_sets: 0,
      valid_volume_kg_reps: 1870,
      volume_status: "partial",
      best_estimated_one_rep_max_kg: 112,
      estimated_one_rep_max_status: "partial",
      suspicious_sets: 3,
      excluded_sets: 3,
    });
  });
});

describe("computeClimbingComparisonMetrics", () => {
  it("returns no metrics when no climbing observations exist", () => {
    expect(computeClimbingComparisonMetrics([])).toBeNull();
  });

  it("merges an exact climb observation imported through two activities", () => {
    const result = computeClimbingComparisonMetrics([
      climbingRow(),
      climbingRow({
        entry_id: "00000000-0000-4000-8000-000000000042",
        entry_activity_id: SOURCE_ACTIVITY_B,
        entry_provider: "strava",
      }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      source_entries: 2,
      entries: 1,
      excluded_ambiguous_entries: 0,
      attempts: 2,
      attempts_status: "complete",
      sends: 1,
      outcomes_status: "complete",
      evidence: [
        {
          status: "included",
          lead: null,
          merged_duplicate: true,
          source_activity_ids: [SOURCE_ACTIVITY_A, SOURCE_ACTIVITY_B],
          source_providers: ["kaya", "strava"],
        },
      ],
    });
  });

  it("excludes conflicting cross-provider observations and marks coverage partial", () => {
    const result = computeClimbingComparisonMetrics([
      climbingRow(),
      climbingRow({
        entry_id: "00000000-0000-4000-8000-000000000042",
        entry_activity_id: SOURCE_ACTIVITY_B,
        entry_provider: "strava",
        sent: false,
        attempt_count: 3,
      }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      source_entries: 2,
      entries: 0,
      excluded_ambiguous_entries: 2,
      attempts: null,
      attempts_status: "unavailable",
      sends: null,
      outcomes_status: "unavailable",
      evidence_count: 2,
    });
    expect(result?.evidence.every((item) => item.status === "excluded_ambiguous")).toBe(true);
  });

  it("marks complete observations partial when other matching climbs are ambiguous", () => {
    const result = computeClimbingComparisonMetrics([
      climbingRow({ route_name: "Independent Route", external_id: "independent" }),
      climbingRow({
        entry_id: "00000000-0000-4000-8000-000000000042",
        route_name: "Conflicted Route",
        external_id: "conflicted",
      }),
      climbingRow({
        entry_id: "00000000-0000-4000-8000-000000000043",
        entry_activity_id: SOURCE_ACTIVITY_B,
        entry_provider: "strava",
        route_name: "Conflicted Route",
        external_id: "conflicted-other",
        sent: false,
        attempt_count: 3,
      }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      entries: 1,
      excluded_ambiguous_entries: 2,
      attempts: 2,
      attempts_status: "partial",
      sends: 1,
      outcomes_status: "partial",
    });
  });

  it("excludes repeated stable IDs from the same source instead of double counting", () => {
    const result = computeClimbingComparisonMetrics([
      climbingRow(),
      climbingRow({
        entry_id: "00000000-0000-4000-8000-000000000042",
      }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      source_entries: 2,
      entries: 0,
      excluded_ambiguous_entries: 2,
      attempts: null,
      sends: null,
    });
  });

  it("does not infer missing attempts or outcomes", () => {
    expect(
      computeClimbingComparisonMetrics([
        climbingRow({ sent: null, attempt_count: null }),
        climbingRow({
          entry_id: "00000000-0000-4000-8000-000000000042",
          route_name: "Green Slab",
          external_id: "problem-2",
        }),
      ]),
    ).toMatchObject({
      attempts: 2,
      attempts_status: "partial",
      sends: 1,
      outcomes_status: "partial",
    });
  });

  it("normalizes identities, preserves failed outcomes, and reports truncated provenance", () => {
    const duplicateSources = Array.from({ length: 21 }, (_, index) =>
      climbingRow({
        entry_id: `entry-${index}`,
        entry_activity_id: `source-${index}`,
        entry_provider: `provider-${index}`,
        external_id: `external-${index}`,
        grade: index === 0 ? " V6 " : "v6",
        route_name: index === 0 ? " Blue   Arete " : "blue arete",
        location_name: index === 0 ? " THE GYM " : "the gym",
        sent: false,
        attempt_count: 1,
      }),
    );
    const distinct = Array.from({ length: 100 }, (_, index) =>
      climbingRow({
        entry_id: `distinct-entry-${index}`,
        entry_activity_id: `distinct-source-${index}`,
        entry_provider: "kaya",
        external_id: `distinct-external-${index}`,
        route_name: `Route ${index}`,
        sent: index % 2 === 0,
        attempt_count: 2,
      }),
    );

    const result = computeClimbingComparisonMetrics([...duplicateSources, ...distinct]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      source_entries: 121,
      entries: 101,
      excluded_ambiguous_entries: 0,
      attempts: 201,
      attempts_status: "complete",
      sends: 50,
      outcomes_status: "complete",
      evidence_count: 101,
      evidence_truncated: true,
    });
    expect(result?.evidence[0]).toMatchObject({
      merged_duplicate: true,
      source_entry_count: 21,
      source_activity_count: 21,
      source_provider_count: 21,
      source_evidence_truncated: true,
      sent: false,
    });
    expect(result?.evidence[0]?.source_entry_ids).toHaveLength(20);
  });

  it("does not report provenance truncation at the exact twenty-source boundary", () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      climbingRow({
        entry_id: `entry-${index}`,
        entry_activity_id: `source-${index}`,
        entry_provider: `provider-${index}`,
        external_id: `external-${index}`,
      }),
    );

    const result = computeClimbingComparisonMetrics(rows);

    expect(result).toMatchSnapshot();
    expect(result?.evidence[0]).toMatchObject({
      source_entry_count: 20,
      source_activity_count: 20,
      source_provider_count: 20,
      source_evidence_truncated: false,
    });
  });

  it("attributes provenance truncation to source activities when that is the only long list", () => {
    const rows = Array.from({ length: 21 }, (_, index) =>
      climbingRow({
        entry_id: "shared-entry",
        entry_activity_id: `source-${index}`,
        entry_provider: "kaya",
        external_id: "shared-external",
      }),
    );

    const result = computeClimbingComparisonMetrics(rows);

    expect(result).toMatchSnapshot();
    expect(result?.evidence[0]).toMatchObject({
      source_entry_count: 1,
      source_activity_count: 21,
      source_provider_count: 1,
      source_evidence_truncated: true,
    });
  });
});
