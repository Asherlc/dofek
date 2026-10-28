import { describe, expect, it } from "vitest";
import { climbingGradeProgressionV1Schema } from "./climbing-progression-v1.ts";

const lane = {
  climbKind: "boulder",
  attemptScope: "climb",
  ropeMethod: null,
  solo: null,
  usedAid: false,
  gradeSystem: "v_scale",
  grades: [{ grade: "V4", gradeSortValue: 65 }],
  settings: ["indoor", "outdoor"],
  axisMax: 3,
  axisInterval: 1,
  axisTicks: [0, 1, 2, 3],
  periods: [
    {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      settings: [
        {
          setting: "indoor",
          climbingDays: 1,
          sends: 1,
          unknownOutcomes: 0,
          sendsPerDay: 1,
          segments: [{ grade: "V4", sends: 1, sendsPerDay: 1, stackStart: 0, stackEnd: 1 }],
        },
        {
          setting: "outdoor",
          climbingDays: 0,
          sends: 0,
          unknownOutcomes: 0,
          sendsPerDay: null,
          segments: [
            { grade: "V4", sends: 0, sendsPerDay: null, stackStart: null, stackEnd: null },
          ],
        },
      ],
    },
  ],
};

describe("climbingGradeProgressionV1Schema", () => {
  it("preserves the complete legacy lane and setting-specific stack contract", () => {
    expect(climbingGradeProgressionV1Schema.parse(lane)).toEqual(lane);
  });

  it("accepts the legacy route, pitch, solo and aid facts", () => {
    const route = {
      ...lane,
      climbKind: "route",
      attemptScope: "pitch",
      ropeMethod: "lead",
      solo: true,
      usedAid: true,
      gradeSystem: "french",
    };
    expect(climbingGradeProgressionV1Schema.parse(route)).toEqual(route);
  });

  it("requires the legacy lane facts and a grade system matching its climb kind", () => {
    expect(
      climbingGradeProgressionV1Schema.safeParse({ ...lane, gradeSystem: "yds" }).success,
    ).toBe(false);
    expect(
      climbingGradeProgressionV1Schema.safeParse({ ...lane, attemptScope: undefined }).success,
    ).toBe(false);
  });

  it("rejects invalid setting observations and non-calendar dates", () => {
    expect(
      climbingGradeProgressionV1Schema.safeParse({
        ...lane,
        periods: [{ ...lane.periods[0], startDate: "2026-02-30" }],
      }).success,
    ).toBe(false);
    expect(
      climbingGradeProgressionV1Schema.safeParse({
        ...lane,
        periods: [
          {
            ...lane.periods[0],
            settings: [{ ...lane.periods[0]?.settings[0], climbingDays: -1 }],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
