import { describe, expect, it, vi } from "vitest";
import {
  type ClimbingProgressionInput,
  ClimbingProgressionRepository,
} from "./climbing-progression-repository.ts";

function queryText(query: unknown): string {
  if (typeof query !== "object" || query === null || !("queryChunks" in query)) {
    throw new Error("Expected Drizzle SQL query object");
  }
  return JSON.stringify(Reflect.get(query, "queryChunks"));
}

function executeDb(rows: Record<string, unknown>[]) {
  return {
    execute: vi.fn((query: unknown) => {
      const text = queryText(query);
      if (text.includes("preceding_consecutive_days")) {
        return Promise.resolve([{ preceding_consecutive_days: 0 }]);
      }
      if (text.includes("AS first_observed_date") && !text.includes("entry_id")) {
        return Promise.resolve([{ first_observed_date: rows[0]?.first_observed_date ?? null }]);
      }
      return Promise.resolve(rows);
    }),
  };
}

const baseRow = {
  activity_id: "00000000-0000-4000-8000-000000000001",
  activity_name: "Evening climbing",
  activity_started_at: "2026-07-10T18:00:00.000Z",
  activity_ended_at: "2026-07-10T20:00:00.000Z",
  session_date: "2026-07-10",
  source_providers: ["kaya"],
  source_external_ids: [
    {
      providerId: "kaya",
      externalId: "session-1",
      memberActivityId: "00000000-0000-4000-8000-000000000011",
      subsource: "Kaya",
    },
  ],
  member_activity_ids: ["00000000-0000-4000-8000-000000000011"],
  timezone: "America/Los_Angeles",
  start_utc_offset_minutes: -420,
  end_utc_offset_minutes: -420,
  local_time_source: "provider_timezone",
  entry_id: "00000000-0000-4000-8000-000000000101",
  entry_activity_id: "00000000-0000-4000-8000-000000000011",
  entry_provider: "kaya",
  external_id: "problem-1",
  climb_type: "boulder",
  grade_system: "v_scale",
  grade: "V5",
  sent: true,
  attempt_count: 3,
  attempts: [],
  ascent_type: "Redpoint",
  lead: null,
  wall_angle_degrees: 30,
  hold_type: null,
  route_name: "Blue Arete",
  location_name: "Pacific Pipe",
  source_name: "Kaya",
  first_observed_date: "2026-07-10",
};

describe("ClimbingProgressionRepository", () => {
  it("preserves unknown attempts and outcomes rather than treating them as zero or failure", async () => {
    const repository = new ClimbingProgressionRepository(
      executeDb([
        {
          ...baseRow,
          attempt_count: null,
          sent: null,
          local_time_source: "unknown",
          timezone: null,
        },
      ]),
      "00000000-0000-4000-8000-000000000002",
      "America/Los_Angeles",
    );

    const result = await repository.listRange({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      providers: [],
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({
      entries: 1,
      entries_with_attempts: 0,
      entries_with_observed_outcome: 0,
      attempt_data: "unavailable",
      timezone_assumed_sessions: 1,
    });
    expect(result.daily[0]).toMatchObject({
      attempts: null,
      attempts_status: "unavailable",
      failed_entries: null,
      observed_outcomes: 0,
      sends: null,
    });
    expect(result.grade_distribution[0]).toMatchObject({
      attempts: null,
      attempts_status: "unavailable",
      normalized_grade: "V5",
      normalized_grade_system: "v_scale",
      observed_outcomes: 0,
      send_rate: null,
      sends: null,
    });
    expect(result.sessions[0]?.climbs[0]).toMatchObject({
      attempt_count: null,
      sent: null,
    });
  });

  it("merges exact cross-provider entry duplicates once and preserves all evidence", async () => {
    const duplicate = {
      ...baseRow,
      source_providers: ["strava", "kaya"],
      member_activity_ids: [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
      ],
      entry_id: "00000000-0000-4000-8000-000000000102",
      entry_activity_id: "00000000-0000-4000-8000-000000000012",
      entry_provider: "strava",
      source_name: "Strava",
      external_id: "strava-problem-9",
      route_name: "  BLUE arete ",
      location_name: " PACIFIC pipe ",
      ascent_type: " redPOINT ",
    };
    const repository = new ClimbingProgressionRepository(
      executeDb([{ ...baseRow, source_providers: ["kaya", "strava"] }, duplicate]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    );

    const result = await repository.listRange({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      providers: [],
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({
      entries: 1,
      merged_exact_duplicate_records: 1,
      possible_duplicate_groups: 0,
    });
    expect(result.daily[0]).toMatchObject({ attempts: 3, entries: 1, sends: 1 });
    expect(result.sessions[0]?.climbs[0]?.provenance).toMatchObject({
      merged_duplicate: true,
      source_entry_ids: [
        "00000000-0000-4000-8000-000000000101",
        "00000000-0000-4000-8000-000000000102",
      ],
      source_providers: ["kaya", "strava"],
    });
  });

  it("flags identity overlaps with conflicting observations without silently merging them", async () => {
    const repository = new ClimbingProgressionRepository(
      executeDb([
        baseRow,
        {
          ...baseRow,
          entry_id: "00000000-0000-4000-8000-000000000102",
          entry_activity_id: "00000000-0000-4000-8000-000000000012",
          entry_provider: "strava",
          external_id: "strava-problem-9",
          attempt_count: 4,
          sent: false,
        },
      ]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    );

    const result = await repository.listRange({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      providers: [],
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });

    expect(result).toMatchSnapshot();
    expect(result.coverage).toMatchObject({
      entries: 2,
      entries_excluded_from_aggregates: 2,
      possible_duplicate_groups: 1,
    });
    expect(result.daily[0]).toMatchObject({
      attempts: null,
      attempts_status: "unavailable",
      entries: 2,
      sends: null,
    });
    expect(result.grade_distribution).toEqual([]);
    expect(result.sessions[0]?.quality_flags).toContain("possible_overlapping_climbing_entries");
    expect(result.sessions[0]?.climbs).toHaveLength(2);
  });

  it("does not merge entries that differ by hold type and merges stable same-provider identities", async () => {
    const rows = [
      baseRow,
      {
        ...baseRow,
        entry_id: "00000000-0000-4000-8000-000000000102",
        entry_activity_id: "00000000-0000-4000-8000-000000000012",
        grade: "V6",
        hold_type: "crimp",
      },
    ];
    const first = await new ClimbingProgressionRepository(
      executeDb(rows),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      providers: [],
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });
    expect(first).toMatchSnapshot();
    expect(first.coverage).toMatchObject({
      entries: 2,
      merged_exact_duplicate_records: 0,
      possible_duplicate_groups: 1,
      entries_excluded_from_aggregates: 2,
    });

    const stableDuplicate = await new ClimbingProgressionRepository(
      executeDb([
        baseRow,
        {
          ...baseRow,
          entry_id: "00000000-0000-4000-8000-000000000103",
          entry_activity_id: "00000000-0000-4000-8000-000000000013",
        },
      ]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      providers: [],
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });
    expect(stableDuplicate).toMatchSnapshot();
    expect(stableDuplicate.coverage).toMatchObject({
      entries: 1,
      merged_exact_duplicate_records: 1,
    });
  });

  it("calculates date-aligned exposure, partial attempts, grade trends, and hardest ascents", async () => {
    const rows = [
      { ...baseRow, ascent_type: "Flash", attempt_count: 1 },
      {
        ...baseRow,
        entry_id: "00000000-0000-4000-8000-000000000102",
        external_id: "problem-2",
        grade: "V6",
        route_name: "Red Roof",
        ascent_type: "Onsight",
        attempt_count: null,
        sent: true,
      },
      {
        ...baseRow,
        activity_id: "00000000-0000-4000-8000-000000000002",
        activity_started_at: "2026-07-12T18:00:00.000Z",
        activity_ended_at: "2026-07-12T19:00:00.000Z",
        session_date: "2026-07-12",
        entry_id: "00000000-0000-4000-8000-000000000103",
        external_id: "problem-3",
        grade: "V7",
        route_name: "Black Slab",
        ascent_type: "Redpoint",
        attempt_count: 5,
      },
    ];
    const repository = new ClimbingProgressionRepository(
      executeDb(rows),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    );

    const result = await repository.listRange({
      startDate: "2026-07-09",
      endDate: "2026-07-12",
      providers: [],
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 1,
    });

    expect(result).toMatchSnapshot();
    expect(result.daily).toEqual([
      expect.objectContaining({ date: "2026-07-09", exposure_status: "unavailable" }),
      expect.objectContaining({
        date: "2026-07-10",
        attempts: 1,
        attempts_status: "partial",
        consecutive_climbing_days: 1,
        rolling_7d_exposure_days: 1,
        sessions: 1,
      }),
      expect.objectContaining({
        date: "2026-07-11",
        exposure_status: "not_observed",
        is_rest_day: true,
      }),
      expect.objectContaining({
        date: "2026-07-12",
        consecutive_climbing_days: 1,
        rolling_7d_exposure_days: 2,
      }),
    ]);
    expect(result.hardest).toMatchObject({
      flash: { grade: "V5", normalized_grade: "V5" },
      onsight: { grade: "V6", normalized_grade: "V6" },
      send: { grade: "V7" },
    });
    expect(result.grade_progression).toEqual([
      expect.objectContaining({ date: "2026-07-10", grade: "V6" }),
      expect.objectContaining({ date: "2026-07-12", grade: "V7" }),
    ]);
    expect(result.below_range_hardest_send).toMatchObject({
      attempts: 1,
      entries: 1,
      metric_name: "volume_below_range_hardest_send",
      status: "partial",
    });
    expect(result.pagination).toMatchObject({ has_more: true });
    expect(result.sessions).toHaveLength(1);
  });

  it("adds exact range and optional filters to the canonical activity query", async () => {
    const db = executeDb([]);
    const repository = new ClimbingProgressionRepository(
      db,
      "00000000-0000-4000-8000-000000000002",
      "America/Los_Angeles",
    );

    await repository.listRange({
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      providers: ["kaya"],
      disciplines: ["boulder"],
      locations: ["Pacific Pipe"],
      gradeSystems: ["v_scale"],
      cursor: null,
      limit: 100,
    });

    const query = JSON.stringify(Reflect.get(db.execute.mock.calls[0]?.[0] ?? {}, "queryChunks"));
    expect(query).toContain("fitness.v_activity");
    expect(query).toContain("ce.activity_id = ANY(a.member_activity_ids)");
    expect(query).toContain("source_activity.provider_id");
    expect(query).toContain("AT TIME ZONE");
    expect(query).toContain("2026-06-04");
    expect(query).toContain("2026-07-31");
    expect(query).toContain("kaya");
    expect(query).toContain("boulder");
    expect(query).toContain("Pacific Pipe");
    expect(query).toContain("v_scale");
    const coverageQuery = JSON.stringify(
      Reflect.get(db.execute.mock.calls[1]?.[0] ?? {}, "queryChunks"),
    );
    expect(coverageQuery).toContain("AS first_observed_date");
    expect(coverageQuery).toContain("kaya");
    expect(coverageQuery).toContain("Pacific Pipe");
    expect(coverageQuery).toContain("v_scale");
    expect(db.execute.mock.calls.map(([query]) => queryText(query))).toMatchSnapshot();
  });

  it("distinguishes a rest-only range after climbing coverage began from unavailable coverage", async () => {
    const execute = vi.fn((query: unknown) => {
      const text = queryText(query);
      if (text.includes("preceding_consecutive_days")) {
        return Promise.resolve([{ preceding_consecutive_days: 0 }]);
      }
      if (text.includes("AS first_observed_date")) {
        return Promise.resolve([{ first_observed_date: "2026-07-01" }]);
      }
      return Promise.resolve([]);
    });
    const repository = new ClimbingProgressionRepository(
      { execute },
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    );

    const result = await repository.listRange({
      startDate: "2026-07-20",
      endDate: "2026-07-20",
      providers: [],
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });

    expect(result).toMatchSnapshot();
    expect(result.coverage.first_observed_date).toBe("2026-07-01");
    expect(result).toMatchSnapshot();
    expect(result.daily).toEqual([
      expect.objectContaining({
        exposure_status: "not_observed",
        is_rest_day: true,
        sessions: 0,
      }),
    ]);
  });

  it("uses pre-range exposure for the first rolling window and consecutive-day streak", async () => {
    const rows = [
      {
        ...baseRow,
        session_date: "2026-07-08",
        activity_id: "00000000-0000-4000-8000-000000000008",
      },
      {
        ...baseRow,
        session_date: "2026-07-09",
        activity_id: "00000000-0000-4000-8000-000000000009",
      },
      baseRow,
    ];
    const db = executeDb(rows);
    db.execute.mockImplementation((query: unknown) => {
      const text = queryText(query);
      if (text.includes("preceding_consecutive_days")) {
        return Promise.resolve([{ preceding_consecutive_days: 2 }]);
      }
      if (text.includes("AS first_observed_date") && !text.includes("entry_id")) {
        return Promise.resolve([{ first_observed_date: "2026-07-08" }]);
      }
      return Promise.resolve(rows);
    });
    const repository = new ClimbingProgressionRepository(
      db,
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    );

    const result = await repository.listRange({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      providers: [],
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });

    expect(result).toMatchSnapshot();
    expect(result.daily).toEqual([
      expect.objectContaining({
        consecutive_climbing_days: 3,
        rolling_7d_exposure_days: 3,
      }),
    ]);
    expect(result.coverage.sessions).toBe(1);
    expect(result.grade_progression).toHaveLength(1);
  });

  it("does not calculate attempts per send from partial grade coverage", async () => {
    const repository = new ClimbingProgressionRepository(
      executeDb([
        baseRow,
        {
          ...baseRow,
          entry_id: "00000000-0000-4000-8000-000000000102",
          external_id: "problem-2",
          attempt_count: null,
          sent: null,
        },
      ]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    );

    const result = await repository.listRange({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      providers: [],
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });

    expect(result).toMatchSnapshot();
    expect(result.grade_distribution[0]).toMatchObject({
      attempts_status: "partial",
      attempts_per_send: null,
    });
  });

  it("does not calculate attempts per send from incomplete outcome coverage", async () => {
    const repository = new ClimbingProgressionRepository(
      executeDb([
        baseRow,
        {
          ...baseRow,
          entry_id: "00000000-0000-4000-8000-000000000102",
          external_id: "problem-2",
          attempt_count: 2,
          sent: null,
        },
      ]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    );

    const result = await repository.listRange({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      providers: [],
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });

    expect(result).toMatchSnapshot();
    expect(result.grade_distribution[0]).toMatchObject({
      attempts_status: "complete",
      observed_outcomes: 1,
      attempts_per_send: null,
    });
  });

  it("uses a request-bound keyset cursor and continues if the cursor row disappears", async () => {
    const firstRows = [
      {
        ...baseRow,
        activity_id: "00000000-0000-4000-8000-000000000003",
        activity_started_at: "2026-07-12T18:00:00.000Z",
        session_date: "2026-07-12",
      },
      {
        ...baseRow,
        activity_id: "00000000-0000-4000-8000-000000000002",
        activity_started_at: "2026-07-11T18:00:00.000Z",
        session_date: "2026-07-11",
      },
    ];
    const input = {
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      providers: [],
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 1,
    } satisfies ClimbingProgressionInput;
    const first = await new ClimbingProgressionRepository(
      executeDb(firstRows),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);
    const cursor = first.pagination.next_cursor;
    expect(cursor).not.toBeNull();

    const secondRow = firstRows[1];
    if (!secondRow) throw new Error("Expected second fixture row");
    const second = await new ClimbingProgressionRepository(
      executeDb([secondRow]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange({ ...input, cursor });

    expect(second.sessions[0]?.activity_id).toBe("00000000-0000-4000-8000-000000000002");
    await expect(
      new ClimbingProgressionRepository(
        executeDb(firstRows),
        "00000000-0000-4000-8000-000000000002",
        "UTC",
      ).listRange({ ...input, cursor: "not-a-valid-cursor" }),
    ).rejects.toThrow("Invalid climbing progression cursor");
    await expect(
      new ClimbingProgressionRepository(
        executeDb(firstRows),
        "00000000-0000-4000-8000-000000000002",
        "UTC",
      ).listRange({ ...input, providers: ["kaya"], cursor }),
    ).rejects.toThrow("Invalid climbing progression cursor");
    await expect(
      new ClimbingProgressionRepository(
        executeDb(firstRows),
        "00000000-0000-4000-8000-000000000002",
        "America/Los_Angeles",
      ).listRange({ ...input, cursor }),
    ).rejects.toThrow("Invalid climbing progression cursor");
  });
});
