import { describe, expect, it, vi } from "vitest";
import { StrengthProgressionRepository } from "./strength-progression-repository.ts";

function queryText(query: unknown): string {
  if (typeof query !== "object" || query === null || !("queryChunks" in query)) {
    throw new Error("Expected Drizzle SQL query object");
  }
  return JSON.stringify(Reflect.get(query, "queryChunks"));
}

function executeDb(rows: Record<string, unknown>[]) {
  return {
    execute: vi.fn((query: unknown) =>
      Promise.resolve(
        queryText(query).includes("first_observed_date")
          ? [{ first_observed_date: "2026-07-01" }]
          : queryText(query).includes("strength_progression_prior")
            ? []
            : rows,
      ),
    ),
  };
}

const baseRow = {
  activity_id: "00000000-0000-4000-8000-000000000001",
  activity_name: "Strength session",
  activity_started_at: "2026-07-01T18:00:00.000Z",
  activity_ended_at: "2026-07-01T19:00:00.000Z",
  session_date: "2026-07-01",
  source_providers: ["strong"],
  source_external_ids: [],
  member_activity_ids: ["00000000-0000-4000-8000-000000000011"],
  timezone: "America/Los_Angeles",
  start_utc_offset_minutes: -420,
  end_utc_offset_minutes: -420,
  local_time_source: "device_timezone",
  set_id: "00000000-0000-4000-8000-000000000101",
  set_activity_id: "00000000-0000-4000-8000-000000000011",
  set_provider: "strong",
  exercise_id: "00000000-0000-4000-8000-000000000201",
  exercise_name: "Bench Press",
  equipment: "Barbell",
  muscle_groups: ["CHEST"],
  exercise_type: "STRENGTH",
  movement: "push",
  exercise_index: 0,
  set_index: 0,
  set_type: "working",
  weight_kg: 100,
  reps: 5,
  distance_meters: null,
  duration_seconds: null,
  rpe: 8,
  notes: null,
  raw: { weight: 100, weightUnit: "kg", reps: 5 },
};

const input = {
  startDate: "2026-07-01",
  endDate: "2026-07-01",
  providers: [],
  exerciseIds: [],
  cursor: null,
  limit: 100,
};

describe("StrengthProgressionRepository", () => {
  it("computes exact progression, PR, filter, and pagination contracts for valid working sets", async () => {
    const laterRow = {
      ...baseRow,
      activity_id: "00000000-0000-4000-8000-000000000002",
      activity_started_at: "2026-07-02T18:00:00.000Z",
      activity_ended_at: "2026-07-02T19:00:00.000Z",
      session_date: "2026-07-02",
      member_activity_ids: ["00000000-0000-4000-8000-000000000012"],
      set_id: "00000000-0000-4000-8000-000000000102",
      set_activity_id: "00000000-0000-4000-8000-000000000012",
      weight_kg: 105,
      raw: { weight: 105, weightUnit: "kg", reps: 5 },
    };
    const priorRow = {
      ...baseRow,
      activity_id: "00000000-0000-4000-8000-000000000003",
      activity_started_at: "2026-06-01T18:00:00.000Z",
      activity_ended_at: "2026-06-01T19:00:00.000Z",
      session_date: "2026-06-01",
      member_activity_ids: ["00000000-0000-4000-8000-000000000013"],
      set_id: "00000000-0000-4000-8000-000000000103",
      set_activity_id: "00000000-0000-4000-8000-000000000013",
      weight_kg: 95,
      raw: { weight: 95, weightUnit: "kg", reps: 5 },
    };
    const db = {
      execute: vi.fn((query: unknown) => {
        const text = queryText(query);
        if (text.includes("first_observed_date")) {
          return Promise.resolve([{ first_observed_date: "2026-06-01" }]);
        }
        if (text.includes("strength_progression_prior")) return Promise.resolve([priorRow]);
        return Promise.resolve([laterRow, baseRow]);
      }),
    };
    const repository = new StrengthProgressionRepository(
      db,
      "00000000-0000-4000-8000-000000000004",
      "America/Los_Angeles",
    );
    const firstPage = await repository.listRange({
      ...input,
      endDate: "2026-07-02",
      providers: ["strong"],
      exerciseIds: [baseRow.exercise_id],
      limit: 1,
    });
    const secondPage = await repository.listRange({
      ...input,
      endDate: "2026-07-02",
      providers: ["strong"],
      exerciseIds: [baseRow.exercise_id],
      cursor: firstPage.pagination.next_cursor,
      limit: 1,
    });

    expect({ firstPage, secondPage }).toMatchSnapshot();
    expect(queryText(db.execute.mock.calls[0]?.[0])).toContain("strong");
    expect(queryText(db.execute.mock.calls[0]?.[0])).toContain(baseRow.exercise_id);
    expect(firstPage.exercises[0]?.estimated_one_rep_max).toMatchObject({
      first_kg: 116.67,
      latest_kg: 122.5,
      change_kg: 5.83,
      change_percent: 5,
    });
    expect(firstPage.exercises[0]?.prs).toHaveLength(2);
    expect(firstPage.pagination.next_cursor).not.toBeNull();
    expect(secondPage.pagination.next_cursor).toBeNull();
  });

  it("retains and flags a probable reversed-field import without using it in aggregates", async () => {
    const suspicious = {
      ...baseRow,
      weight_kg: 11,
      reps: 140,
      raw: { weight: 11, weightUnit: "lb", reps: 140 },
    };
    const result = await new StrengthProgressionRepository(
      executeDb([suspicious]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);

    expect(result).toMatchSnapshot();
    expect(result.sessions[0]?.exercises[0]?.sets[0]?.quality_flags).toEqual([
      "implausible_repetitions",
      "possible_reversed_fields_or_import_corruption",
    ]);
    expect(result.summary.total_volume_kg_reps).toBe(0);
  });

  it("retains but excludes duplicate identities from the same provider", async () => {
    const duplicate = {
      ...baseRow,
      set_id: "00000000-0000-4000-8000-000000000102",
    };
    const result = await new StrengthProgressionRepository(
      executeDb([baseRow, duplicate]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({
      source_sets: 2,
      sets: 2,
      merged_exact_duplicate_records: 0,
      flagged_sets: 2,
      sets_excluded_from_volume: 2,
    });
    expect(result.sessions[0]?.exercises[0]?.sets).toHaveLength(2);
    expect(result.sessions[0]?.exercises[0]?.sets).toEqual([
      expect.objectContaining({ quality_flags: ["duplicate_same_source_set_identity"] }),
      expect.objectContaining({ quality_flags: ["duplicate_same_source_set_identity"] }),
    ]);
    expect(result.summary.total_volume_kg_reps).toBe(0);
  });

  it("deduplicates equivalent provider sets when exercise display ordering differs", async () => {
    const duplicate = {
      ...baseRow,
      source_providers: ["strong", "whoop"],
      member_activity_ids: [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
      ],
      set_id: "00000000-0000-4000-8000-000000000102",
      set_activity_id: "00000000-0000-4000-8000-000000000012",
      set_provider: "whoop",
      exercise_index: 4,
      raw: { weight_kg: 100, number_of_reps: 5 },
    };
    const result = await new StrengthProgressionRepository(
      executeDb([{ ...baseRow, source_providers: ["strong", "whoop"] }, duplicate]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({
      source_sets: 2,
      sets: 1,
      merged_exact_duplicate_records: 1,
    });
    expect(result.summary.total_volume_kg_reps).toBe(500);
  });

  it("deduplicates exact sets from distinct same-provider canonical members", async () => {
    const duplicate = {
      ...baseRow,
      member_activity_ids: [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
      ],
      set_id: "00000000-0000-4000-8000-000000000102",
      set_activity_id: "00000000-0000-4000-8000-000000000012",
    };
    const result = await new StrengthProgressionRepository(
      executeDb([baseRow, duplicate]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({ sets: 1, merged_exact_duplicate_records: 1 });
    expect(result.summary.total_volume_kg_reps).toBe(500);
  });

  it("flags differing sets from distinct same-provider canonical members", async () => {
    const conflict = {
      ...baseRow,
      member_activity_ids: [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
      ],
      set_id: "00000000-0000-4000-8000-000000000102",
      set_activity_id: "00000000-0000-4000-8000-000000000012",
      weight_kg: 105,
    };
    const result = await new StrengthProgressionRepository(
      executeDb([baseRow, conflict]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({ sets: 2, flagged_sets: 2 });
    expect(result.summary.total_volume_kg_reps).toBe(0);
  });

  it("keeps repeated exercise occurrences distinct instead of collapsing reset set indexes", async () => {
    const repeatedBlock = {
      ...baseRow,
      set_id: "00000000-0000-4000-8000-000000000102",
      exercise_index: 4,
    };
    const result = await new StrengthProgressionRepository(
      executeDb([baseRow, repeatedBlock]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({ sets: 2, flagged_sets: 0 });
    expect(result.summary.total_volume_kg_reps).toBe(1000);
  });

  it("flags same-source identity conflicts even when their values differ", async () => {
    const conflict = {
      ...baseRow,
      set_id: "00000000-0000-4000-8000-000000000102",
      weight_kg: 105,
    };
    const result = await new StrengthProgressionRepository(
      executeDb([baseRow, conflict]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({ sets: 2, flagged_sets: 2 });
    expect(result.summary.total_volume_kg_reps).toBe(0);
  });

  it("does not treat null set types or non-positive load/reps as valid working volume", async () => {
    const nullType = { ...baseRow, set_type: null, weight_kg: 0, reps: 0 };
    const result = await new StrengthProgressionRepository(
      executeDb([nullType]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);

    expect(result).toMatchSnapshot();
    expect(result.summary).toMatchObject({ valid_working_sets: 0, total_volume_kg_reps: 0 });
    expect(result.sessions[0]?.exercises[0]?.sets[0]).toMatchObject({
      is_working_set: false,
      quality_flags: ["missing_set_type", "non_positive_repetitions", "non_positive_weight"],
      volume: { status: "unavailable", value_kg_reps: null, reason: "quality_flags" },
    });
  });

  it("does not flag valid zero-valued Strong rest intervals as corrupt", async () => {
    const rest = {
      ...baseRow,
      set_type: "rest",
      weight_kg: 0,
      reps: 0,
      duration_seconds: 300,
    };
    const result = await new StrengthProgressionRepository(
      executeDb([rest]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);

    expect(result).toMatchSnapshot();
    expect(result.coverage.flagged_sets).toBe(0);
    expect(result.sessions[0]?.exercises[0]?.sets[0]).toMatchObject({
      is_working_set: false,
      quality_flags: [],
      volume: { status: "unavailable", reason: "non_working_set" },
    });
  });

  it("keeps conflicting cross-provider values visible and excludes both observations", async () => {
    const conflict = {
      ...baseRow,
      source_providers: ["strong", "whoop"],
      member_activity_ids: [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
      ],
      set_id: "00000000-0000-4000-8000-000000000102",
      set_activity_id: "00000000-0000-4000-8000-000000000012",
      set_provider: "whoop",
      weight_kg: 105,
      raw: { weight_kg: 105, number_of_reps: 5 },
    };
    const result = await new StrengthProgressionRepository(
      executeDb([{ ...baseRow, source_providers: ["strong", "whoop"] }, conflict]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({
      possible_duplicate_groups: 1,
      flagged_sets: 2,
      sets_excluded_from_volume: 2,
    });
    expect(result.summary.total_volume_kg_reps).toBe(0);
    expect(result.sessions[0]?.exercises[0]?.sets).toEqual([
      expect.objectContaining({
        quality_flags: ["possible_overlapping_conflicting_set"],
        excluded_from_aggregates: true,
      }),
      expect.objectContaining({
        quality_flags: ["possible_overlapping_conflicting_set"],
        excluded_from_aggregates: true,
      }),
    ]);
  });
});
