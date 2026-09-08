import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  type FingerLoadingProgressionInput,
  FingerLoadingProgressionRepository,
} from "./finger-loading-progression-repository.ts";
import { collectSqlText } from "./test-helpers.ts";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const ACTIVITY_ID = "00000000-0000-4000-8000-000000000010";
const SOURCE_ACTIVITY_ID = "00000000-0000-4000-8000-000000000011";
const ENTRY_ID = "00000000-0000-4000-8000-000000000100";

function row(overrides: Record<string, unknown> = {}) {
  return {
    activity_id: ACTIVITY_ID,
    activity_name: "Max hangs",
    activity_started_at: "2026-07-10T18:00:00.000Z",
    activity_ended_at: "2026-07-10T18:30:00.000Z",
    session_date: "2026-07-10",
    source_providers: ["manual"],
    source_external_ids: [
      {
        providerId: "manual",
        externalId: "hang-session-1",
        memberActivityId: SOURCE_ACTIVITY_ID,
      },
    ],
    member_activity_ids: [SOURCE_ACTIVITY_ID],
    timezone: "America/Los_Angeles",
    start_utc_offset_minutes: -420,
    end_utc_offset_minutes: -420,
    local_time_source: "provider_timezone",
    entry_id: ENTRY_ID,
    entry_activity_id: SOURCE_ACTIVITY_ID,
    entry_provider: "manual",
    exercise: "max_hang",
    edge_size_mm: 20,
    grip_position: "half_crimp",
    external_load_kg: 20,
    bodyweight_kg: 80,
    laterality: "both",
    set_count: 5,
    hold_duration_seconds: 10,
    rest_interval_seconds: 180,
    rpe: 8,
    notes: "Controlled",
    ...overrides,
  };
}

function databaseFor(
  rows: Record<string, unknown>[],
  firstObservedDate: string | null = "2026-07-10",
  climbingDates: string[] = [],
  climbingFirstObservedDate: string | null = "2026-07-10",
) {
  const execute = vi.fn(async (query: SQL): Promise<Record<string, unknown>[]> => {
    const text = collectSqlText(query);
    if (text.includes("first_observed_climbing_date")) {
      return [{ first_observed_climbing_date: climbingFirstObservedDate }];
    }
    if (text.includes("first_observed_date")) {
      return [{ first_observed_date: firstObservedDate }];
    }
    if (text.includes("preceding_consecutive_days")) {
      return [{ preceding_consecutive_days: 0 }];
    }
    if (text.includes("climbing_exposure_date")) {
      return climbingDates.map((date) => ({ climbing_exposure_date: date }));
    }
    return rows;
  });
  return { execute };
}

const baseInput: FingerLoadingProgressionInput = {
  startDate: "2026-07-10",
  endDate: "2026-07-11",
  providers: [],
  exercises: [],
  thresholds: {
    minEffectiveLoadKg: null,
    minLoadToBodyweightRatio: null,
    minRpe: null,
  },
  cursor: null,
  limit: 100,
};

describe("FingerLoadingProgressionRepository", () => {
  it("returns a separate finger-load channel with exact exposure calculations and provenance", async () => {
    const database = databaseFor([row()]);
    const result = await new FingerLoadingProgressionRepository(database, USER_ID, "UTC").listRange(
      baseInput,
    );

    expect(result).toMatchSnapshot();
    expect(result.channel).toEqual({
      id: "finger_loading",
      interchangeable_with: [],
      note: expect.stringContaining("separate"),
    });
    expect(result.summary).toMatchObject({
      sessions: 1,
      entries: 1,
      total_time_under_tension_seconds: null,
      effective_load_kg_seconds: null,
      exposure_calculation: {
        status: "unavailable",
        reason:
          "Exact exposure requires repetitions per set, which the canonical source schema does not record.",
      },
      max_effective_load_kg: 100,
      max_load_to_bodyweight_ratio: 1.25,
    });
    expect(result.high_intensity).toEqual({
      status: "unavailable",
      thresholds: {
        min_effective_load_kg: null,
        min_load_to_bodyweight_ratio: null,
        min_rpe: null,
      },
      matching_entries: null,
      days: null,
      reason: "High-intensity classification requires at least one caller-supplied threshold.",
    });
    expect(result.daily).toEqual([
      expect.objectContaining({
        date: "2026-07-10",
        exposure_status: "observed",
        entries: 1,
        sessions: 1,
        total_time_under_tension_seconds: null,
        effective_load_kg_seconds: null,
        max_effective_load_kg: 100,
        max_load_to_bodyweight_ratio: 1.25,
        high_intensity_entries: null,
        high_intensity_day: null,
        consecutive_finger_loading_days: 1,
      }),
      expect.objectContaining({
        date: "2026-07-11",
        exposure_status: "not_observed",
        entries: 0,
        sessions: 0,
        effective_load_kg_seconds: null,
        consecutive_finger_loading_days: 0,
      }),
    ]);
    expect(result.sessions[0]).toMatchObject({
      activity_id: ACTIVITY_ID,
      date: "2026-07-10",
      timezone: { value: "America/Los_Angeles", assumed: false },
      entries: [
        {
          id: ENTRY_ID,
          protocol: "max_hang",
          grip_type: "half_crimp",
          edge_size_mm: 20,
          original_external_load_kg: 20,
          added_weight_kg: 20,
          assistance_kg: 0,
          bodyweight_kg: 80,
          effective_load_kg: 100,
          load_to_bodyweight_ratio: 1.25,
          hang_duration_seconds: 10,
          rest_duration_seconds: 180,
          pain: null,
          pain_status: "not_recorded_by_canonical_schema",
          repetitions_per_set: null,
          repetitions_status: "not_recorded_by_canonical_schema",
          sets: 5,
          laterality: "both",
          rpe: 8,
          notes: "Controlled",
          total_time_under_tension_seconds: null,
          effective_load_kg_seconds: null,
          exposure_calculation: {
            status: "unavailable",
            reason:
              "Exact exposure requires repetitions per set, which the canonical source schema does not record.",
          },
          high_intensity: null,
          provenance: {
            value_kind: "mixed",
            source_recorded_fields: expect.arrayContaining([
              "bodyweight_kg",
              "original_external_load_kg",
              "sets",
            ]),
            calculated_fields: expect.arrayContaining([
              "effective_load_kg",
              "load_to_bodyweight_ratio",
            ]),
            source_entry_ids: [ENTRY_ID],
            source_activity_ids: [SOURCE_ACTIVITY_ID],
            source_providers: ["manual"],
            merged_duplicate: false,
          },
        },
      ],
    });
    expect(result.combined_climbing_finger_exposure).toMatchObject({
      definition: expect.stringContaining("does not combine numeric load"),
      first_joint_coverage_date: "2026-07-10",
      daily: [
        {
          date: "2026-07-10",
          finger_loading: true,
          finger_loading_status: "observed",
          climbing: false,
          climbing_status: "not_observed",
          any_exposure: true,
          exposure_status: "observed",
          consecutive_exposure_days: 1,
        },
        {
          date: "2026-07-11",
          finger_loading: false,
          finger_loading_status: "not_observed",
          climbing: false,
          climbing_status: "not_observed",
          any_exposure: false,
          exposure_status: "not_observed",
          consecutive_exposure_days: 0,
        },
      ],
    });

    const queries = database.execute.mock.calls.map((call) => collectSqlText(call[0]));
    expect(queries[0]).toContain("FROM fitness.v_activity AS a");
    expect(queries[0]).toContain("entry.activity_id = ANY(a.member_activity_ids)");
  });

  it("preserves assistance and missing optional observations without manufacturing repetitions", async () => {
    const result = await new FingerLoadingProgressionRepository(
      databaseFor([
        row({
          edge_size_mm: null,
          grip_position: null,
          external_load_kg: -20,
          rpe: null,
          notes: null,
        }),
      ]),
      USER_ID,
      "UTC",
    ).listRange(baseInput);

    expect(result).toMatchSnapshot();
    expect(result.sessions[0]?.entries[0]).toMatchObject({
      edge_size_mm: null,
      grip_type: null,
      original_external_load_kg: -20,
      added_weight_kg: 0,
      assistance_kg: 20,
      effective_load_kg: 60,
      load_to_bodyweight_ratio: 0.75,
      repetitions_per_set: null,
      rpe: null,
      notes: null,
    });
  });

  it("classifies high intensity only from explicit thresholds using any configured threshold", async () => {
    const result = await new FingerLoadingProgressionRepository(
      databaseFor([row(), row({ entry_id: "00000000-0000-4000-8000-000000000101", rpe: 9 })]),
      USER_ID,
      "UTC",
    ).listRange({
      ...baseInput,
      thresholds: {
        minEffectiveLoadKg: 110,
        minLoadToBodyweightRatio: null,
        minRpe: 9,
      },
    });

    expect(result).toMatchSnapshot();
    expect(result.high_intensity).toMatchObject({
      status: "available",
      matching_entries: 1,
      days: 1,
      reason: null,
    });
    expect(result.definitions.high_intensity).toContain("any configured threshold");
    expect(result.daily[0]).toMatchObject({ high_intensity_entries: 1, high_intensity_day: true });
  });

  it("consolidates exact duplicate observations from different canonical members", async () => {
    const result = await new FingerLoadingProgressionRepository(
      databaseFor([
        row(),
        row({
          entry_id: "00000000-0000-4000-8000-000000000101",
          entry_activity_id: "00000000-0000-4000-8000-000000000012",
          entry_provider: "mirror",
        }),
      ]),
      USER_ID,
      "UTC",
    ).listRange(baseInput);

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({ entries: 1, merged_exact_duplicate_records: 1 });
    expect(result.summary).toMatchObject({ entries: 1, effective_load_kg_seconds: null });
    expect(result.sessions[0]?.entries[0]?.provenance).toEqual({
      value_kind: "mixed",
      source_recorded_fields: [
        "protocol",
        "grip_type",
        "edge_size_mm",
        "original_external_load_kg",
        "bodyweight_kg",
        "hang_duration_seconds",
        "rest_duration_seconds",
        "sets",
        "laterality",
        "rpe",
        "notes",
      ],
      calculated_fields: [
        "added_weight_kg",
        "assistance_kg",
        "effective_load_kg",
        "load_to_bodyweight_ratio",
        "high_intensity",
      ],
      source_entry_ids: [
        "00000000-0000-4000-8000-000000000100",
        "00000000-0000-4000-8000-000000000101",
      ],
      source_activity_ids: [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
      ],
      source_providers: ["manual", "mirror"],
      merged_duplicate: true,
    });
  });

  it("flags conflicting provider-member observations and excludes them from aggregates", async () => {
    const result = await new FingerLoadingProgressionRepository(
      databaseFor([
        row(),
        row({
          entry_id: "00000000-0000-4000-8000-000000000102",
          entry_activity_id: "00000000-0000-4000-8000-000000000012",
          entry_provider: "mirror",
          external_load_kg: 25,
        }),
      ]),
      USER_ID,
      "UTC",
    ).listRange(baseInput);

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({
      entries: 2,
      possible_duplicate_groups: 1,
      entries_excluded_from_aggregates: 2,
    });
    expect(result.summary).toMatchObject({ entries: 0, max_effective_load_kg: null });
    expect(result.sessions[0]).toMatchObject({
      quality_flags: ["possible_overlapping_finger_loading_entries"],
      entries: [
        expect.objectContaining({
          excluded_from_aggregates: true,
          quality_flags: ["possible_overlapping_provider_observation"],
        }),
        expect.objectContaining({
          excluded_from_aggregates: true,
          quality_flags: ["possible_overlapping_provider_observation"],
        }),
      ],
    });
  });

  it("uses the activity's recorded offset for local dates and applies provider/protocol filters", async () => {
    const database = databaseFor([]);
    await new FingerLoadingProgressionRepository(database, USER_ID, "Europe/Helsinki").listRange({
      ...baseInput,
      providers: ["manual"],
      exercises: ["max_hang"],
    });

    const query = database.execute.mock.calls[0]?.[0];
    const text = collectSqlText(query);
    expect(text).toContain("a.start_utc_offset_minutes * INTERVAL '1 minute'");
    expect(text).toContain("source_activity.provider_id IN");
    expect(text).toContain("entry.exercise::text IN");
    expect(JSON.stringify(query)).toContain("manual");
    expect(JSON.stringify(query)).toContain("max_hang");
  });

  it("continues combined exposure streaks across climbing-only and finger-loading days", async () => {
    const result = await new FingerLoadingProgressionRepository(
      databaseFor([row()], "2026-07-10", ["2026-07-11"]),
      USER_ID,
      "UTC",
    ).listRange(baseInput);

    expect(result).toMatchSnapshot();
    expect(result.combined_climbing_finger_exposure.daily).toEqual([
      {
        date: "2026-07-10",
        finger_loading: true,
        finger_loading_status: "observed",
        climbing: false,
        climbing_status: "not_observed",
        any_exposure: true,
        exposure_status: "observed",
        consecutive_exposure_days: 1,
      },
      {
        date: "2026-07-11",
        finger_loading: false,
        finger_loading_status: "not_observed",
        climbing: true,
        climbing_status: "observed",
        any_exposure: true,
        exposure_status: "observed",
        consecutive_exposure_days: 2,
      },
    ]);
  });

  it("keeps combined absence and streak unavailable until both channels have coverage", async () => {
    const result = await new FingerLoadingProgressionRepository(
      databaseFor([row()], "2026-07-10", [], "2026-07-11"),
      USER_ID,
      "UTC",
    ).listRange(baseInput);

    expect(result).toMatchSnapshot();
    expect(result.combined_climbing_finger_exposure).toMatchObject({
      first_joint_coverage_date: "2026-07-11",
      daily: [
        {
          date: "2026-07-10",
          finger_loading: true,
          finger_loading_status: "observed",
          climbing: null,
          climbing_status: "unavailable",
          any_exposure: true,
          exposure_status: "observed",
          consecutive_exposure_days: null,
        },
        {
          date: "2026-07-11",
          finger_loading: false,
          finger_loading_status: "not_observed",
          climbing: false,
          climbing_status: "not_observed",
          any_exposure: false,
          exposure_status: "not_observed",
          consecutive_exposure_days: 0,
        },
      ],
    });
  });

  it("rejects a cursor bound to another request shape", async () => {
    const repository = new FingerLoadingProgressionRepository(
      databaseFor([
        row(),
        row({
          activity_id: "00000000-0000-4000-8000-000000000020",
          activity_started_at: "2026-07-11T18:00:00.000Z",
          session_date: "2026-07-11",
          entry_id: "00000000-0000-4000-8000-000000000200",
          entry_activity_id: "00000000-0000-4000-8000-000000000021",
        }),
      ]),
      USER_ID,
      "UTC",
    );
    const first = await repository.listRange({ ...baseInput, limit: 0 + 1 });
    const cursor = first.pagination.next_cursor;
    expect(cursor).not.toBeNull();

    await expect(
      repository.listRange({
        ...baseInput,
        providers: ["manual"],
        cursor,
        limit: 1,
      }),
    ).rejects.toThrow("Invalid finger-loading progression cursor");
  });
});
