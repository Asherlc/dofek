import type { ClimbingGradePreference } from "@dofek/training/climbing-grades";
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
