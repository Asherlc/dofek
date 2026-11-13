import { climbingGradeProgressionV1Schema } from "@dofek/training/climbing-progression-v1";
import { describe, expect, it } from "vitest";
import type { ClimbingProgressionEntry } from "./climbing-grade-progression.ts";
import { buildClimbingGradeProgressionV1 } from "./climbing-grade-progression-v1.ts";

const boulderEntry: ClimbingProgressionEntry = {
  date: "2026-01-02",
  attemptScope: "climb",
  ropeMethod: null,
  solo: null,
  usedAid: null,
  climbKind: "boulder",
  setting: "indoor",
  gradeSystem: "v_scale",
  grade: "V4",
  gradeSortValue: 65,
  sends: 1,
  unknownOutcomes: 0,
};

const routeEntry: ClimbingProgressionEntry = {
  ...boulderEntry,
  climbKind: "route",
  ropeMethod: "lead",
  gradeSystem: "yds",
  grade: "5.10a",
  gradeSortValue: 61,
};

describe("buildClimbingGradeProgressionV1", () => {
  it("returns no lanes for no recorded grades", () => {
    expect(buildClimbingGradeProgressionV1([])).toEqual([]);
  });

  it("preserves legacy setting-specific distinct-day denominators and grade stacks", () => {
    const [lane] = buildClimbingGradeProgressionV1([
      { ...boulderEntry, grade: "V3", gradeSortValue: 61, sends: 2 },
      boulderEntry,
      { ...boulderEntry, date: "2026-01-03", sends: 0, unknownOutcomes: 1 },
      { ...boulderEntry, setting: "outdoor", sends: 4 },
      { ...boulderEntry, setting: "unknown", sends: 0 },
    ]);

    expect(lane).toMatchObject({
      climbKind: "boulder",
      attemptScope: "climb",
      ropeMethod: null,
      solo: null,
      usedAid: null,
      gradeSystem: "v_scale",
      grades: [
        { grade: "V3", gradeSortValue: 61 },
        { grade: "V4", gradeSortValue: 65 },
      ],
      settings: ["indoor", "outdoor", "unknown"],
      axisMax: 6,
      axisInterval: 2,
      axisTicks: [0, 2, 4, 6],
      periods: [
        {
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          settings: [
            {
              setting: "indoor",
              climbingDays: 2,
              sends: 3,
              unknownOutcomes: 1,
              sendsPerDay: 1.5,
              segments: [
                { grade: "V3", sends: 2, sendsPerDay: 1, stackStart: 0, stackEnd: 1 },
                { grade: "V4", sends: 1, sendsPerDay: 0.5, stackStart: 1, stackEnd: 1.5 },
              ],
            },
            { setting: "outdoor", climbingDays: 1, sends: 4, sendsPerDay: 4 },
            { setting: "unknown", climbingDays: 1, sends: 0, sendsPerDay: 0 },
          ],
        },
      ],
    });
    expect(climbingGradeProgressionV1Schema.parse(lane)).toEqual(lane);
  });

  it("keeps kind, scope, rope method, solo and aid combinations in separate lanes", () => {
    const entries: ClimbingProgressionEntry[] = [
      boulderEntry,
      routeEntry,
      { ...routeEntry, attemptScope: "pitch" },
      { ...routeEntry, ropeMethod: "top_rope" },
      { ...routeEntry, solo: false },
      { ...routeEntry, solo: true },
      { ...routeEntry, usedAid: false },
      { ...routeEntry, usedAid: true },
    ];
    const lanes = buildClimbingGradeProgressionV1(entries);

    expect(lanes).toHaveLength(entries.length);
    for (const entry of entries) {
      const lane = lanes.find(
        (candidate) =>
          candidate.climbKind === entry.climbKind &&
          candidate.attemptScope === entry.attemptScope &&
          candidate.ropeMethod === entry.ropeMethod &&
          candidate.solo === entry.solo &&
          candidate.usedAid === entry.usedAid,
      );
      expect(lane).toMatchObject({
        gradeSystem: entry.gradeSystem,
        periods: [{ settings: [{ climbingDays: 1, sends: 1, sendsPerDay: 1 }] }],
      });
    }
    expect(buildClimbingGradeProgressionV1([...entries].reverse())).toEqual(lanes);
  });

  it("keeps retained grade scales in separate lanes with a stable order", () => {
    const lanes = buildClimbingGradeProgressionV1([
      boulderEntry,
      { ...boulderEntry, gradeSystem: "font", grade: "6A", gradeSortValue: 60, setting: "outdoor" },
    ]);

    expect(lanes).toMatchObject([
      {
        gradeSystem: "font",
        grades: [{ grade: "6A", gradeSortValue: 60 }],
        settings: ["outdoor"],
        periods: [{ settings: [{ climbingDays: 1, sends: 1, sendsPerDay: 1 }] }],
      },
      {
        gradeSystem: "v_scale",
        grades: [{ grade: "V4", gradeSortValue: 65 }],
        settings: ["indoor"],
        periods: [{ settings: [{ climbingDays: 1, sends: 1, sendsPerDay: 1 }] }],
      },
    ]);
  });

  it("orders tied grades by label and uses the greatest supplied sort value for each grade", () => {
    const [lane] = buildClimbingGradeProgressionV1([
      routeEntry,
      { ...routeEntry, grade: "5.10" },
      { ...routeEntry, gradeSortValue: 60 },
    ]);

    expect(lane?.grades).toEqual([
      { grade: "5.10", gradeSortValue: 61 },
      { grade: "5.10a", gradeSortValue: 61 },
    ]);
    expect(lane?.periods[0]?.settings[0]).toMatchObject({
      climbingDays: 1,
      sends: 3,
      sendsPerDay: 3,
      segments: [
        { grade: "5.10", sends: 1, sendsPerDay: 1, stackStart: 0, stackEnd: 1 },
        { grade: "5.10a", sends: 2, sendsPerDay: 2, stackStart: 1, stackEnd: 3 },
      ],
    });
  });

  it("distinguishes recorded zero-send days from missing settings and periods", () => {
    const [lane] = buildClimbingGradeProgressionV1([
      { ...boulderEntry, sends: 0 },
      { ...boulderEntry, date: "2026-03-02", setting: "outdoor", sends: 0, unknownOutcomes: 1 },
    ]);

    expect(lane).toMatchObject({ axisMax: 1, axisInterval: 1, axisTicks: [0, 1] });
    expect(lane?.periods).toMatchObject([
      {
        startDate: "2026-01-01",
        settings: [
          {
            setting: "indoor",
            climbingDays: 1,
            sendsPerDay: 0,
            segments: [{ grade: "V4", sendsPerDay: 0, stackStart: 0, stackEnd: 0 }],
          },
          { setting: "outdoor", climbingDays: 0, sendsPerDay: null },
        ],
      },
      {
        startDate: "2026-02-01",
        settings: [
          {
            climbingDays: 0,
            sendsPerDay: null,
            segments: [{ grade: "V4", sendsPerDay: null, stackStart: null, stackEnd: null }],
          },
          { climbingDays: 0, sendsPerDay: null },
        ],
      },
      {
        startDate: "2026-03-01",
        settings: [
          { setting: "indoor", climbingDays: 0, sendsPerDay: null },
          { setting: "outdoor", climbingDays: 1, sends: 0, unknownOutcomes: 1, sendsPerDay: 0 },
        ],
      },
    ]);
  });

  it("shares the calendar and axis across lanes and clips the last multi-month period", () => {
    const lanes = buildClimbingGradeProgressionV1([
      { ...boulderEntry, date: "2025-01-31", sends: 8 },
      { ...routeEntry, date: "2026-04-01" },
      { ...routeEntry, date: "2026-04-03", sends: 0 },
    ]);

    expect(lanes).toHaveLength(2);
    for (const lane of lanes) {
      expect(lane).toMatchObject({ axisMax: 9, axisInterval: 3, axisTicks: [0, 3, 6, 9] });
      expect(lane.periods).toHaveLength(6);
      expect(lane.periods[0]).toMatchObject({ startDate: "2025-01-01", endDate: "2025-03-31" });
      expect(lane.periods[5]).toMatchObject({ startDate: "2026-04-01", endDate: "2026-04-30" });
    }
    expect(lanes.find((lane) => lane.climbKind === "route")?.periods[5]?.settings[0]).toMatchObject(
      {
        climbingDays: 2,
        sends: 1,
        sendsPerDay: 0.5,
      },
    );
  });
});
