import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import type { ClimbingGradePreference } from "@dofek/training/climbing-grades";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ClimbingRepository } from "./climbing-repository.ts";

function repository(rows: Record<string, unknown>[], preference?: ClimbingGradePreference) {
  return new ClimbingRepository(
    { execute: vi.fn().mockResolvedValue(rows) },
    "user",
    "UTC",
    undefined,
    preference,
  );
}
const boulder = { climb_kind: "boulder", grade_system: "v_scale", grade: "V4" };
const route = { climb_kind: "route", grade_system: "yds", grade: "5.10c" };
describe("ClimbingRepository weekly volume", () => {
  it.each([30, null])(
    "returns weekly observations without replacing unknown values for %s days",
    async (days) => {
      const weeks = [
        { week: "2026-10-19", attempts: null, minutes: 90 },
        { week: "2026-10-26", attempts: 5, minutes: null },
      ];
      expect(await repository(weeks).getVolumeOverTime(days)).toEqual(weeks);
    },
  );
  it.each([
    [{}, false],
    [{ setting: undefined }, false],
    [{ setting: ["outdoor"] }, true],
    [{ setting: ["outdoor"], climbKind: undefined }, true],
  ] satisfies [ClimbingFilters, boolean][])(
    "binds the recorded-activity filter gate for %j",
    async (filters, expected) => {
      const execute = vi.fn().mockResolvedValue([]);
      const repo = new ClimbingRepository({ execute }, "user", "UTC");
      await repo.getVolumeOverTime(30, filters);
      const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(query.params.at(-1)).toBe(expected);
    },
  );
  it("binds a caller-local end date for an all-time query", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T01:00:00Z"));
    try {
      const execute = vi.fn().mockResolvedValue([]);
      const repo = new ClimbingRepository({ execute }, "user", "America/Los_Angeles");
      await repo.getVolumeOverTime(null);
      const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(query.params).toContain("2026-10-26");
      expect(query.params).not.toContain(undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("ClimbingRepository map entries", () => {
  const location = {
    coordinates: { latitude: 0, longitude: -122.25 },
    scope: "area",
    objectId: "area",
    providerId: "openbeta",
    name: "Crag",
  };
  const entry = {
    id: "log",
    activity_id: null,
    session_date: "2026-10-01",
    climb_name: "Corner",
    title: null,
    provider_id: "openbeta",
    raw: null,
    location,
    ...route,
  };
  it("returns a display-ready grade in the user's selected grade system", async () => {
    expect(
      await repository([entry], { boulder: "font", route: "french" }).getMapEntries(30),
    ).toEqual([
      {
        id: "log",
        activityId: null,
        date: "2026-10-01",
        label: "Corner",
        grade: "6b",
        location,
      },
    ]);
  });
  it.each([
    { grade: null, grade_system: "yds" },
    { grade: "5.10c", grade_system: null },
    { grade: "unknown", grade_system: "yds" },
  ])("keeps located participation when its published grade is unavailable: %j", async (grade) => {
    expect(await repository([{ ...entry, ...grade }]).getMapEntries(30)).toEqual([
      expect.objectContaining({ id: "log", grade: null, location }),
    ]);
  });
  it("uses a retained Kaya color for an unnamed map entry", async () => {
    expect(
      await repository([
        {
          ...entry,
          climb_name: null,
          provider_id: "kaya",
          raw: { climb: { color: { name: "Blue" } } },
          ...boulder,
        },
      ]).getMapEntries(30),
    ).toMatchObject([{ label: "Blue boulder" }]);
  });
  it("returns no map entries without located observations", async () => {
    expect(await repository([]).getMapEntries(30)).toEqual([]);
  });
});
describe("ClimbingRepository display-grade aggregation", () => {
  it.each(["getGradeProgression", "getVolumeByGrade", "getSessionSummaries"] as const)(
    "returns empty %s for no observations",
    async (method) => {
      expect(await repository([])[method](30)).toEqual([]);
    },
  );
  it("converts compatible source grades to each selected preference", async () => {
    const result = await repository(
      [
        { ...boulder, attempts: 6, recorded_attempts: 6, sends: 4 },
        { ...route, attempts: 2, recorded_attempts: 2, sends: 1 },
      ],
      { boulder: "font", route: "french" },
    ).getVolumeByGrade(30);
    expect(result.map((row) => row.toDetail())).toEqual([
      {
        climbKind: "route",
        gradeSystem: "french",
        grade: "6b",
        gradeSortValue: 64.5,
        attempts: 2,
        recordedAttempts: 2,
        sends: 1,
      },
      {
        climbKind: "boulder",
        gradeSystem: "font",
        grade: "6a+/6b+",
        gradeSortValue: 65,
        attempts: 6,
        recordedAttempts: 6,
        sends: 4,
      },
    ]);
  });
  it.each<[number | null, number | null]>([
    [3, null],
    [null, 3],
    [null, null],
  ])(
    "preserves conflicting totals while merging display-equivalent grades %s/%s",
    async (first, second) => {
      const result = await repository([
        { ...boulder, grade: "V5", attempts: first, recorded_attempts: first, sends: 1 },
        {
          ...boulder,
          grade_system: "font",
          grade: "6C",
          attempts: second,
          recorded_attempts: second,
          sends: 2,
        },
      ]).getVolumeByGrade(30);
      expect(result.map((row) => row.toDetail())).toEqual([
        expect.objectContaining({
          grade: "V5",
          attempts: null,
          recordedAttempts: first === null && second === null ? null : (first ?? 0) + (second ?? 0),
          sends: 3,
        }),
      ]);
    },
  );
  it("merges equivalent buckets and rejects grades that cannot be converted", async () => {
    const result = await repository([
      { ...boulder, attempts: 3, recorded_attempts: 3, sends: 1 },
      { ...boulder, attempts: 2, recorded_attempts: 2, sends: 2 },
      { ...boulder, grade: "unrecognized", attempts: 9, recorded_attempts: 9, sends: 9 },
    ]).getVolumeByGrade(30);
    expect(result.map((row) => row.toDetail())).toEqual([
      expect.objectContaining({ grade: "V4", attempts: 5, sends: 3 }),
    ]);
  });
  it("uses individual attempt facts for progression lanes", async () => {
    const [lead, topRope] = await repository([
      {
        ...route,
        session_date: "2026-10-01",
        attempt_scope: "climb",
        setting: "unknown",
        attempt_observations: [
          { ropeMethod: "lead", solo: true, usedAid: false, sends: 1, unknownOutcomes: 0 },
          { ropeMethod: "top_rope", solo: false, usedAid: true, sends: 0, unknownOutcomes: 0 },
        ],
      },
    ]).getGradeProgression(30);
    expect(lead?.toDetail()).toMatchObject({
      ropeMethod: "lead",
      solo: true,
      usedAid: false,
      periods: [{ settings: [{ sends: 1, climbingDays: 1 }] }],
    });
    expect(topRope?.toDetail()).toMatchObject({
      ropeMethod: "top_rope",
      solo: false,
      usedAid: true,
      periods: [{ settings: [{ sends: 0, climbingDays: 1 }] }],
    });
  });
  it("retains recorded days and unknown outcomes in progression", async () => {
    const result = await repository([
      {
        ...boulder,
        session_date: "2026-01-02",
        attempt_scope: "climb",
        setting: "indoor",
        attempt_observations: [
          { ropeMethod: null, solo: null, usedAid: null, sends: 0, unknownOutcomes: 1 },
        ],
      },
    ]).getGradeProgression(30);
    expect(result[0]?.toDetail()).toMatchObject({
      grades: [{ grade: "V4" }],
      periods: [{ settings: [{ sends: 0, unknownOutcomes: 1, climbingDays: 1 }] }],
    });
  });
});

describe("ClimbingRepository session summaries", () => {
  const session = {
    activity_id: "activity",
    session_date: "2026-10-01",
    name: "Climbing",
    location_name: null,
    attempt_count: 1,
    sends: 1,
    ...boulder,
  };
  it("keeps a recorded location and chooses the hardest sent grade in each kind", async () => {
    const result = await repository([
      { ...session, grade: "V3", attempt_count: 2 },
      { ...session, grade: "V8", sends: 0, attempt_count: 3, location_name: "First gym" },
      { ...session, attempt_count: 4, location_name: "Second gym" },
      { ...session, ...route, attempt_count: 5 },
      { ...session, ...route, grade: "5.11a", attempt_count: 6 },
    ]).getSessionSummaries(30);
    expect(result[0]?.toDetail()).toMatchObject({
      locationName: "First gym",
      attempts: 20,
      sends: 4,
      hardestBoulderGrade: "V4",
      hardestRouteGrade: "5.11a",
    });
  });
  it("retains ungraded participation and known sends", async () => {
    const result = await repository([
      { ...session, grade: null, grade_system: null, sends: 2, attempt_count: 3 },
    ]).getSessionSummaries(30);
    expect(result[0]?.toDetail()).toMatchObject({
      attempts: 3,
      sends: 2,
      hardestBoulderGrade: null,
    });
  });
  it.each([
    { grade: "V4", grade_system: null },
    { grade: null, grade_system: "v_scale" },
  ])("retains participation when only part of the grade is known %j", async (grade) => {
    const [result] = await repository([{ ...session, ...grade }]).getSessionSummaries(30);
    expect(result?.toDetail()).toMatchObject({ attempts: 1, sends: 1, hardestBoulderGrade: null });
  });
  it("keeps the hardest sent grade when easier observations follow", async () => {
    const [result] = await repository([
      { ...session, grade: "V7" },
      { ...session, grade: "V2" },
      { ...session, ...route, grade: "5.11a" },
      { ...session, ...route, grade: "5.8" },
    ]).getSessionSummaries(30);
    expect(result?.toDetail()).toMatchObject({
      hardestBoulderGrade: "V7",
      hardestRouteGrade: "5.11a",
      attempts: 4,
      sends: 4,
    });
  });
  it.each([
    {
      first: { grade: "4b+", grade_system: "french" },
      second: { grade: "5", grade_system: "saxon" },
      expected: "5.7",
    },
    {
      first: { grade: "5", grade_system: "saxon" },
      second: { grade: "4b+", grade_system: "french" },
      expected: "5.6/5.7",
    },
  ])(
    "preserves the first observed display label for tied route grades $expected",
    async ({ first, second, expected }) => {
      const [result] = await repository([
        { ...session, ...route, ...first },
        { ...session, ...route, ...second },
      ]).getSessionSummaries(30);
      expect(result?.toDetail().hardestRouteGrade).toBe(expected);
    },
  );
  it.each<[number | null, number | null]>([
    [3, null],
    [null, 3],
    [null, null],
  ])("keeps unknown session totals for %s/%s", async (first, second) => {
    const result = await repository([
      { ...session, attempt_count: first },
      { ...session, attempt_count: second, sends: 0 },
    ]).getSessionSummaries(30);
    expect(result[0]?.toDetail()).toMatchObject({
      attempts: null,
      sends: 1,
      hardestBoulderGrade: "V4",
    });
  });
  it("sorts sessions by descending source-resolved date", async () => {
    const result = await repository([
      session,
      { ...session, activity_id: "later", session_date: "2026-10-02" },
    ]).getSessionSummaries(30);
    expect(result.map((row) => row.toDetail().activityId)).toEqual(["later", "activity"]);
  });
});

describe("ClimbingRepository attached rock observations", () => {
  it("projects all scoped observation facts and preserves independently missing grade fields", async () => {
    const observation = {
      activity_id: "activity",
      session_date: "2026-10-01",
      climb_kind: "route",
      attempt_scope: "pitch",
      grade_system: "yds",
      grade: "5.10c",
      attempt_count: 3,
      sends: 1,
      observed_outcomes: 2,
      unknown_outcomes: 1,
    };
    expect(
      await repository([
        observation,
        { ...observation, grade_system: null },
        { ...observation, grade: null },
      ]).getAttachedRockObservations("2026-10-01", "2026-10-02"),
    ).toEqual([
      {
        activityId: "activity",
        date: "2026-10-01",
        climbKind: "route",
        attemptScope: "pitch",
        displayGrade: { grade: "5.10c", gradeSystem: "yds", gradeSortValue: 64.5 },
        recordedAttempts: 3,
        sends: 1,
        observedOutcomes: 2,
        unknownOutcomes: 1,
      },
      ...[0, 1].map(() => ({
        activityId: "activity",
        date: "2026-10-01",
        climbKind: "route",
        attemptScope: "pitch",
        displayGrade: null,
        recordedAttempts: 3,
        sends: 1,
        observedOutcomes: 2,
        unknownOutcomes: 1,
      })),
    ]);
    expect(await repository([]).getAttachedRockObservations("2026-10-01", "2026-10-02")).toEqual(
      [],
    );
  });
});

// Query wiring coverage complements the executable PostgreSQL access-window tests.
describe("ClimbingRepository access-policy wiring", () => {
  it.each([
    "getGradeProgression",
    "getVolumeByGrade",
    "getSessionSummaries",
    "getMapEntries",
  ] as const)(
    "forwards restricted access dates to both canonical branches for %s",
    async (method) => {
      const execute = vi.fn().mockResolvedValue([]);
      const startDate = "2026-10-19";
      const endDateExclusive = "2026-10-26";
      const repo = new ClimbingRepository({ execute }, "user", "America/Los_Angeles", {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate,
        endDateExclusive,
      });
      await repo[method](90);
      expect(execute).toHaveBeenCalledOnce();
      const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(query.params.filter((value) => value === startDate)).toHaveLength(2);
      expect(query.params.filter((value) => value === endDateExclusive)).toHaveLength(2);
    },
  );
});
