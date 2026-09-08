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
});

describe("computeClimbingComparisonMetrics", () => {
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
});
