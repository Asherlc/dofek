import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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
  it("preserves each supplied provider and exercise predicate and returns its evidence", async () => {
    const db = executeDb([baseRow]);
    const repo = new StrengthProgressionRepository(db, baseRow.activity_id, "UTC");
    const providers = ["strong", "whoop"];
    const exerciseIds = [baseRow.exercise_id, "00000000-0000-4000-8000-000000000202"];
    const result = await repo.listRange({ ...input, providers, exerciseIds });
    const dialect = new PgDialect();
    const queries = db.execute.mock.calls.map(([query]) => {
      if (!(query instanceof SQL)) throw new Error("Expected SQL");
      return dialect.sqlToQuery(query);
    });
    for (const query of queries) {
      for (const provider of providers) {
        expect(query.params.filter((value) => value === provider)).toHaveLength(2);
      }
      for (const exerciseId of exerciseIds) expect(query.params).toContain(exerciseId);
    }
    expect(result.sessions[0]?.exercises[0]).toMatchObject({
      exercise_id: baseRow.exercise_id,
      sets: [
        expect.objectContaining({
          provenance: expect.objectContaining({ source_providers: ["strong"] }),
        }),
      ],
    });
    db.execute.mockClear();
    await repo.listRange(input);
    for (const [query] of db.execute.mock.calls) {
      if (!(query instanceof SQL)) throw new Error("Expected SQL");
      const { params } = dialect.sqlToQuery(query);
      for (const provider of providers) expect(params).not.toContain(provider);
      for (const exerciseId of exerciseIds) expect(params).not.toContain(exerciseId);
    }
  });

  it("excludes ambiguous cross-provider repeated exercise occurrences with explicit quality evidence", async () => {
    const rows = [
      baseRow,
      { ...baseRow, exercise_index: 2, set_id: "00000000-0000-4000-8000-000000000102" },
      {
        ...baseRow,
        set_activity_id: "00000000-0000-4000-8000-000000000012",
        set_provider: "whoop",
        set_id: "00000000-0000-4000-8000-000000000103",
      },
    ];
    const repo = new StrengthProgressionRepository(executeDb(rows), baseRow.activity_id, "UTC");
    expect((await repo.listLoggedSetComparison(null)).exercises).toEqual([]);
    const progression = await repo.listRange(input);
    expect(progression.sessions[0]?.exercises[0]?.sets.map((set) => set.quality_flags)).toEqual([
      ["ambiguous_cross_provider_exercise_occurrence"],
      ["ambiguous_cross_provider_exercise_occurrence"],
      ["ambiguous_cross_provider_exercise_occurrence"],
    ]);
  });

  it("ranks rep choices by observed dates then repetitions rather than discovery order", async () => {
    const rows = [
      { ...baseRow, reps: 8 },
      { ...baseRow, reps: 8, activity_id: baseRow.set_id, session_date: "2026-07-02" },
      {
        ...baseRow,
        reps: 5,
        set_index: 1,
        activity_id: baseRow.set_id,
        session_date: "2026-07-02",
      },
      { ...baseRow, reps: 5, activity_id: baseRow.exercise_id, session_date: "2026-07-03" },
      {
        ...baseRow,
        reps: 12,
        set_index: 1,
        activity_id: baseRow.exercise_id,
        session_date: "2026-07-03",
      },
    ];
    const result = await new StrengthProgressionRepository(
      executeDb(rows),
      baseRow.activity_id,
      "UTC",
    ).listLoggedSetComparison(null);
    expect(
      result.exercises
        .find(({ exerciseId }) => exerciseId === baseRow.exercise_id)
        ?.comparisons.map(({ reps, observedDates }) => ({ reps, observedDates })),
    ).toEqual([
      { reps: 5, observedDates: 2 },
      { reps: 8, observedDates: 2 },
      { reps: 12, observedDates: 1 },
    ]);
  });

  it("orders canonical identities, session evidence, and rep comparisons independently of incoming rows", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const row = (activity: number, day: number, set: number, reps: number, weight: number) => ({
      ...baseRow,
      activity_id: id(activity),
      set_activity_id: id(activity + 1000),
      session_date: `2026-07-0${day}`,
      set_id: id(set),
      set_index: set,
      reps,
      weight_kg: weight,
    });
    const rows = [
      row(4, 3, 408, 8, 70),
      row(4, 3, 409, 5, 115),
      row(3, 1, 307, 5, 80), // lighter session on the first date
      row(2, 1, 207, 5, 100), // equal daily maximum; lowest activity ID wins
      row(1, 1, 108, 8, 65),
      row(1, 1, 109, 5, 90),
      row(1, 1, 106, 5, 100),
      row(1, 1, 105, 5, 100),
      row(1, 1, 104, 5, 85), // lower set ID must not displace a heavier set
      row(5, 2, 508, 8, 68),
      row(5, 2, 509, 5, 110),
      row(5, 2, 510, 3, 125),
      row(4, 3, 410, 3, 130),
    ];
    const duplicate = {
      ...rows[7],
      set_id: id(999),
      set_activity_id: id(9999),
      set_provider: "whoop",
    };
    const variant = { ...row(6, 2, 608, 8, 30), exercise_id: id(202), equipment: "Dumbbell" };
    const alphabetic = {
      ...row(7, 2, 708, 8, 30),
      exercise_id: id(203),
      exercise_name: "Arm Curl",
    };
    const result = await new StrengthProgressionRepository(
      executeDb([variant, ...rows, duplicate, alphabetic]),
      baseRow.activity_id,
      "UTC",
    ).listLoggedSetComparison(null);
    expect(result.research).toEqual({
      summary:
        "Over eight weeks, the study found no statistically significant difference in tested squat or bench-press one-rep max gains among trained men assigned one, three, or five supervised sets per exercise per session, performed to failure. These observed logged sets and loads do not establish personal causation or prescribe set targets.",
      url: "https://pmc.ncbi.nlm.nih.gov/articles/pmid/30153194/",
    });
    expect(result.exercises.map(({ exerciseId }) => exerciseId)).toEqual([
      id(203),
      id(201),
      id(202),
    ]);
    const exercise = result.exercises.find(({ exerciseId }) => exerciseId === id(201));
    expect(exercise?.totalLoggedSets).toBe(13);
    const evidence = (
      setId: number,
      reps: number,
      weightKg: number,
      sourceProviders = ["strong"],
    ) => ({
      setId: id(setId),
      reps,
      weightKg,
      sourceProviders,
    });
    const session = (
      activity: number,
      day: number,
      loggedSets: number,
      heaviestSets: ReturnType<typeof evidence>[],
      sourceProviders = ["strong"],
    ) => ({
      activityId: id(activity),
      date: `2026-07-0${day}`,
      loggedSets,
      heaviestSets,
      sourceProviders,
    });
    expect(exercise?.sessions).toEqual([
      session(
        1,
        1,
        5,
        [evidence(105, 5, 100, ["strong", "whoop"]), evidence(108, 8, 65)],
        ["strong", "whoop"],
      ),
      session(2, 1, 1, [evidence(207, 5, 100)]),
      session(3, 1, 1, [evidence(307, 5, 80)]),
      session(5, 2, 3, [evidence(510, 3, 125), evidence(509, 5, 110), evidence(508, 8, 68)]),
      session(4, 3, 3, [evidence(410, 3, 130), evidence(409, 5, 115), evidence(408, 8, 70)]),
    ]);
    const endpoint = (
      activity: number,
      day: number,
      set: number,
      reps: number,
      weight: number,
      providers = ["strong"],
    ) => ({
      ...evidence(set, reps, weight, providers),
      activityId: id(activity),
      date: `2026-07-0${day}`,
    });
    expect(exercise?.comparisons).toEqual([
      {
        reps: 5,
        observedDates: 3,
        first: endpoint(1, 1, 105, 5, 100, ["strong", "whoop"]),
        latest: endpoint(4, 3, 409, 5, 115),
      },
      {
        reps: 8,
        observedDates: 3,
        first: endpoint(1, 1, 108, 8, 65),
        latest: endpoint(4, 3, 408, 8, 70),
      },
      {
        reps: 3,
        observedDates: 2,
        first: endpoint(5, 2, 510, 3, 125),
        latest: endpoint(4, 3, 410, 3, 130),
      },
    ]);
  });

  it("keeps same-day sessions and selects daily maximums without comparing different reps", async () => {
    const later = {
      ...baseRow,
      activity_id: "00000000-0000-4000-8000-000000000002",
      session_date: "2026-07-02",
      weight_kg: 105,
    };
    const sameDay = {
      ...later,
      activity_id: "00000000-0000-4000-8000-000000000003",
      weight_kg: 110,
    };
    const otherReps = { ...sameDay, set_index: 1, reps: 8, weight_kg: 80 };
    const result = await new StrengthProgressionRepository(
      executeDb([sameDay, otherReps, later, baseRow]),
      baseRow.activity_id,
      "UTC",
    ).listLoggedSetComparison(null);
    const exercise = result.exercises[0];
    expect(exercise?.sessions).toHaveLength(3);
    expect(exercise?.comparisons).toMatchObject([
      {
        reps: 5,
        observedDates: 2,
        first: { date: "2026-07-01", weightKg: 100 },
        latest: { date: "2026-07-02", activityId: sameDay.activity_id, weightKg: 110 },
      },
      { reps: 8, observedDates: 1, first: { weightKg: 80 }, latest: null },
    ]);
    expect(
      exercise?.sessions
        .find(({ activityId }) => activityId === later.activity_id)
        ?.heaviestSets.map(({ reps }) => reps),
    ).toEqual([5]);
  });

  it("compares heaviest logged sets for each observed rep count", async () => {
    const rows = [
      baseRow,
      { ...baseRow, set_index: 1, set_id: "00000000-0000-4000-8000-000000000102", weight_kg: 110 },
      {
        ...baseRow,
        set_index: 2,
        set_id: "00000000-0000-4000-8000-000000000103",
        reps: 8,
        weight_kg: 80,
      },
    ];
    const result = await new StrengthProgressionRepository(
      executeDb(rows),
      "00000000-0000-4000-8000-000000000004",
      "UTC",
    ).listLoggedSetComparison(30);
    expect(result.exercises[0]?.sessions[0]?.loggedSets).toBe(3);
    expect(result.exercises[0]?.comparisons.map(({ reps }) => reps)).toEqual([5, 8]);
  });
  it("compares distinct dates at matching reps and keeps same-day sessions separate", async () => {
    const later = {
      ...baseRow,
      activity_id: "00000000-0000-4000-8000-000000000002",
      session_date: "2026-07-02",
      weight_kg: 110,
    };
    const sameDay = {
      ...later,
      activity_id: "00000000-0000-4000-8000-000000000003",
      weight_kg: 115,
    };
    const otherReps = {
      ...later,
      set_id: "00000000-0000-4000-8000-000000000105",
      set_index: 1,
      reps: 8,
    };
    const result = await new StrengthProgressionRepository(
      executeDb([baseRow, later, sameDay, otherReps]),
      baseRow.activity_id,
      "UTC",
    ).listLoggedSetComparison(null);
    expect(result.exercises[0]?.sessions).toHaveLength(3);
    expect(result.exercises[0]?.comparisons).toMatchObject([
      {
        reps: 5,
        observedDates: 2,
        first: { weightKg: 100 },
        latest: { weightKg: 115, activityId: sameDay.activity_id },
      },
      { reps: 8, observedDates: 1, latest: null },
    ]);
  });

  it("consolidates equivalent source records and excludes invalid or ambiguous load evidence", async () => {
    const duplicate = {
      ...baseRow,
      set_provider: "whoop",
      set_activity_id: "00000000-0000-4000-8000-000000000012",
      set_id: "00000000-0000-4000-8000-000000000102",
    };
    const invalid = ["warmup", "rest", null].map((set_type, index) => ({
      ...baseRow,
      set_type,
      set_index: index + 1,
    }));
    const missing = { ...baseRow, set_index: 4, weight_kg: null, set_provider: "crimpd" };
    const result = await new StrengthProgressionRepository(
      executeDb([baseRow, duplicate, ...invalid, missing]),
      baseRow.activity_id,
      "UTC",
    ).listLoggedSetComparison(null);
    expect(result.exercises[0]?.totalLoggedSets).toBe(1);
    expect(result.exercises[0]?.sessions[0]?.heaviestSets[0]?.sourceProviders).toEqual([
      "strong",
      "whoop",
    ]);
  });

  it("keeps normalized exercise and equipment variants distinct", async () => {
    const variant = {
      ...baseRow,
      exercise_id: "00000000-0000-4000-8000-000000000202",
      equipment: "Dumbbell",
    };
    const result = await new StrengthProgressionRepository(
      executeDb([baseRow, variant]),
      baseRow.activity_id,
      "UTC",
    ).listLoggedSetComparison(null);
    expect(
      result.exercises.map(({ equipment, totalLoggedSets }) => ({ equipment, totalLoggedSets })),
    ).toEqual([
      { equipment: "Barbell", totalLoggedSets: 1 },
      { equipment: "Dumbbell", totalLoggedSets: 1 },
    ]);
  });

  it("computes exact progression, PR, filter, and pagination contracts for valid working sets", async () => {
    const recordedFailure = {
      ...baseRow.raw,
      setTag: "Failure",
      exerciseName: "Bench Press (Barbell)",
      reportedWeightUnit: "kg",
    };
    const taggedRow = { ...baseRow, set_provider: "strong-csv", raw: recordedFailure };
    const laterRow = {
      ...taggedRow,
      activity_id: "00000000-0000-4000-8000-000000000002",
      activity_started_at: "2026-07-02T18:00:00.000Z",
      activity_ended_at: "2026-07-02T19:00:00.000Z",
      session_date: "2026-07-02",
      member_activity_ids: ["00000000-0000-4000-8000-000000000012"],
      set_id: "00000000-0000-4000-8000-000000000102",
      set_activity_id: "00000000-0000-4000-8000-000000000012",
      weight_kg: 105,
      raw: { ...recordedFailure, weight: 105 },
    };
    const priorRow = {
      ...taggedRow,
      activity_id: "00000000-0000-4000-8000-000000000003",
      activity_started_at: "2026-06-01T18:00:00.000Z",
      activity_ended_at: "2026-06-01T19:00:00.000Z",
      session_date: "2026-06-01",
      member_activity_ids: ["00000000-0000-4000-8000-000000000013"],
      set_id: "00000000-0000-4000-8000-000000000103",
      set_activity_id: "00000000-0000-4000-8000-000000000013",
      weight_kg: 95,
      raw: { ...recordedFailure, weight: 95 },
    };
    const db = {
      execute: vi.fn((query: unknown) => {
        const text = queryText(query);
        if (text.includes("first_observed_date")) {
          return Promise.resolve([{ first_observed_date: "2026-06-01" }]);
        }
        if (text.includes("strength_progression_prior")) return Promise.resolve([priorRow]);
        return Promise.resolve([laterRow, taggedRow]);
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
      first_kg: 116.65,
      latest_kg: 122.48,
      change_kg: 5.83,
      change_percent: 5,
    });
    expect(firstPage.exercises[0]?.prs).toHaveLength(2);
    expect(firstPage.pagination.next_cursor).not.toBeNull();
    expect(secondPage.pagination.next_cursor).toBeNull();
  });

  it("ranks sets and PRs and calculates changes before rounding", async () => {
    const tagged = (weight: number, index: number) => ({
      ...baseRow,
      set_provider: "strong-csv",
      set_index: index,
      set_id: `00000000-0000-4000-8000-00000000010${index}`,
      weight_kg: weight,
      reps: 2,
      raw: {
        weight,
        reps: 2,
        setTag: "Failure",
        exerciseName: "Bench Press (Barbell)",
        weightUnit: "kg",
        reportedWeightUnit: "kg",
      },
    });
    const lighter = tagged(100.001, 1);
    const heavier = tagged(100.002, 2);
    const latest = {
      ...tagged(100.006, 3),
      session_date: "2026-07-02",
      activity_id: "00000000-0000-4000-8000-000000000003",
      activity_started_at: "2026-07-02T18:00:00.000Z",
    };
    const prior = {
      ...tagged(100, 4),
      session_date: "2026-06-30",
      activity_id: "00000000-0000-4000-8000-000000000004",
    };
    for (const rows of [
      [lighter, heavier, latest],
      [heavier, lighter, latest],
    ]) {
      const db = {
        execute: vi.fn((query: unknown) =>
          Promise.resolve(
            queryText(query).includes("first_observed_date")
              ? [{ first_observed_date: prior.session_date }]
              : queryText(query).includes("strength_progression_prior")
                ? [prior]
                : rows,
          ),
        ),
      };
      const result = await new StrengthProgressionRepository(
        db,
        "00000000-0000-4000-8000-000000000002",
        "UTC",
      ).listRange({ ...input, endDate: latest.session_date });
      const exercise = result.exercises[0];
      expect(exercise?.estimated_one_rep_max).toMatchObject({
        first_kg: 106.66,
        latest_kg: 106.67,
        change_kg: 0,
        observations: [
          expect.objectContaining({ set_id: heavier.set_id, value_kg: 106.66 }),
          expect.objectContaining({ set_id: latest.set_id, value_kg: 106.67 }),
        ],
      });
      expect(exercise?.prs[0]).toMatchObject({
        set_id: heavier.set_id,
        value_kg: 106.66,
        previous_best_kg: 106.66,
        previous_best_evidence: { set_id: prior.set_id, value_kg: 106.66 },
      });
    }
  });

  it("keeps a consolidated set in volume when its explicit source evidence conflicts", async () => {
    const clean = {
      ...baseRow,
      set_provider: "strong-csv",
      raw: {
        ...baseRow.raw,
        setTag: "Failure",
        exerciseName: "Bench Press (Barbell)",
        reportedWeightUnit: "kg",
      },
    };
    const conflict = {
      ...clean,
      set_id: "00000000-0000-4000-8000-000000000102",
      set_activity_id: "00000000-0000-4000-8000-000000000012",
      raw: { ...clean.raw, weight: 99 },
    };
    const result = await new StrengthProgressionRepository(
      executeDb([clean, conflict]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);
    expect(result.exercises[0]).toMatchObject({
      total_volume_kg_reps: 500,
      estimated_one_rep_max: { best_kg: null },
    });
    expect(result.sessions[0]?.exercises[0]?.sets[0]?.estimated_one_rep_max).toMatchObject({
      reason: "conflicting_failure_evidence",
      value_kg: null,
    });
  });

  it("reports a first PR with no change when only one qualifying day exists", async () => {
    const tagged = {
      ...baseRow,
      set_provider: "strong-csv",
      raw: {
        ...baseRow.raw,
        setTag: "Failure",
        exerciseName: "Bench Press (Barbell)",
        reportedWeightUnit: "kg",
      },
    };
    const lighter = {
      ...tagged,
      set_id: "00000000-0000-4000-8000-000000000102",
      set_index: 1,
      weight_kg: 80,
      raw: { ...tagged.raw, weight: 80 },
    };
    const priorUnknownEffort = { ...baseRow, session_date: "2026-06-30" };
    const db = {
      execute: vi.fn((query: unknown) => {
        const text = queryText(query);
        if (text.includes("first_observed_date"))
          return Promise.resolve([{ first_observed_date: priorUnknownEffort.session_date }]);
        if (text.includes("strength_progression_prior"))
          return Promise.resolve([priorUnknownEffort]);
        return Promise.resolve([lighter, tagged]);
      }),
    };
    const result = await new StrengthProgressionRepository(
      db,
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);
    expect(result.exercises[0]).toMatchObject({
      estimated_one_rep_max: {
        first_kg: 116.65,
        latest_kg: 116.65,
        change_kg: null,
        change_percent: null,
      },
      daily: [{ best_estimated_one_rep_max_kg: 116.65 }],
      prs: [
        {
          set_id: tagged.set_id,
          previous_best_kg: null,
          previous_best_evidence: null,
        },
      ],
    });
  });

  it("keeps a tagged single in history without calculating an estimate", async () => {
    const single = {
      ...baseRow,
      set_provider: "strong-csv",
      reps: 1,
      raw: {
        ...baseRow.raw,
        reps: 1,
        setTag: "Failure",
        exerciseName: "Bench Press (Barbell)",
        reportedWeightUnit: "kg",
      },
    };
    const result = await new StrengthProgressionRepository(
      executeDb([single]),
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    ).listRange(input);
    expect(result.sessions[0]?.exercises[0]?.sets[0]).toMatchObject({
      normalized: { weight_kg: 100, reps: 1 },
      original: { values: { setTag: "Failure" } },
      estimated_one_rep_max: { status: "unavailable", value_kg: null },
    });
    expect(result.exercises[0]?.estimated_one_rep_max).toMatchObject({
      observations: [],
      change_kg: null,
    });
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
