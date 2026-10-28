import { describe, expect, it } from "vitest";
import {
  buildClimbingGradeProgression,
  type ClimbingProgressionEntry,
} from "./climbing-grade-progression.ts";

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

describe("buildClimbingGradeProgression", () => {
  it("pools types, methods and settings before counting distinct days and grade stacks", () => {
    const chart = buildClimbingGradeProgression([
      boulderEntry,
      { ...routeEntry, setting: "outdoor" },
      { ...routeEntry, ropeMethod: "top_rope", setting: "unknown" },
      { ...routeEntry, date: "2026-01-03", ropeMethod: null, usedAid: false },
      { ...boulderEntry, date: "2026-01-04", sends: 0, unknownOutcomes: 1 },
    ]);
    expect(chart).toMatchObject({
      grades: [
        {
          key: '["boulder","v_scale","V4"]',
          climbKind: "boulder",
          gradeSystem: "v_scale",
          grade: "V4",
        },
        { key: '["route","yds","5.10a"]', climbKind: "route", gradeSystem: "yds", grade: "5.10a" },
      ],
      periods: [
        {
          climbingDays: 3,
          sends: 4,
          unknownOutcomes: 1,
          sendsPerDay: 4 / 3,
          segments: [
            {
              gradeKey: '["boulder","v_scale","V4"]',
              sends: 1,
              sendsPerDay: 1 / 3,
              stackStart: 0,
              stackEnd: 1 / 3,
            },
            {
              gradeKey: '["route","yds","5.10a"]',
              sends: 3,
              sendsPerDay: 1,
              stackStart: 1 / 3,
              stackEnd: 4 / 3,
            },
          ],
        },
      ],
      axisMax: 3,
      axisInterval: 1,
      axisTicks: [0, 1, 2, 3],
    });
    expect(chart?.grades).toHaveLength(2);
  });

  it("keeps a visible zero baseline when all outcomes are failed or unknown", () => {
    const chart = buildClimbingGradeProgression([
      { ...boulderEntry, sends: 0, unknownOutcomes: 0 },
      { ...boulderEntry, date: "2026-03-02", sends: 0, unknownOutcomes: 1 },
    ]);
    expect(chart).toMatchObject({
      axisMax: 1,
      axisInterval: 1,
      axisTicks: [0, 1],
      periods: [
        {
          startDate: "2026-01-01",
          climbingDays: 1,
          sends: 0,
          unknownOutcomes: 0,
          sendsPerDay: 0,
          segments: [{ sends: 0, stackStart: 0, stackEnd: 0 }],
        },
        {
          startDate: "2026-02-01",
          climbingDays: 0,
          sends: 0,
          sendsPerDay: null,
          segments: [{ sendsPerDay: null, stackStart: null, stackEnd: null }],
        },
        { startDate: "2026-03-01", climbingDays: 1, sends: 0, unknownOutcomes: 1, sendsPerDay: 0 },
      ],
    });
  });

  it("keeps identical labels on retained grade scales distinct with a stable order", () => {
    const chart = buildClimbingGradeProgression([
      boulderEntry,
      { ...boulderEntry, gradeSystem: "font", grade: "6A", gradeSortValue: 60 },
      { ...routeEntry, gradeSystem: "french", grade: "6A", gradeSortValue: 60 },
    ]);
    expect(chart?.grades).toEqual([
      {
        key: '["boulder","font","6A"]',
        climbKind: "boulder",
        gradeSystem: "font",
        grade: "6A",
        gradeSortValue: 60,
      },
      {
        key: '["boulder","v_scale","V4"]',
        climbKind: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        gradeSortValue: 65,
      },
      {
        key: '["route","french","6A"]',
        climbKind: "route",
        gradeSystem: "french",
        grade: "6A",
        gradeSortValue: 60,
      },
    ]);
    expect(chart?.periods[0]?.segments.map((segment) => segment.gradeKey)).toEqual(
      chart?.grades.map((grade) => grade.key),
    );
  });

  it("orders tied grades by label and preserves each grade's stack", () => {
    const chart = buildClimbingGradeProgression([routeEntry, { ...routeEntry, grade: "5.10" }]);
    expect(chart?.grades.map((grade) => grade.grade)).toEqual(["5.10", "5.10a"]);
    expect(chart?.periods[0]).toMatchObject({
      climbingDays: 1,
      sends: 2,
      sendsPerDay: 2,
      segments: [
        {
          gradeKey: '["route","yds","5.10"]',
          sends: 1,
          sendsPerDay: 1,
          stackStart: 0,
          stackEnd: 1,
        },
        {
          gradeKey: '["route","yds","5.10a"]',
          sends: 1,
          sendsPerDay: 1,
          stackStart: 1,
          stackEnd: 2,
        },
      ],
    });
  });

  it("places sends in multi-month bins and scales every stack by recorded days", () => {
    const chart = buildClimbingGradeProgression([
      { ...boulderEntry, date: "2025-01-31", grade: "V3", gradeSortValue: 61 },
      { ...boulderEntry, date: "2025-02-01", grade: "V3", gradeSortValue: 61 },
      { ...boulderEntry, date: "2025-02-01" },
      { ...boulderEntry, date: "2026-04-01" },
      { ...boulderEntry, date: "2026-04-03", sends: 0 },
    ]);
    expect(chart?.periods).toHaveLength(6);
    expect(chart?.periods[0]).toMatchObject({
      startDate: "2025-01-01",
      endDate: "2025-03-31",
      climbingDays: 2,
      sends: 3,
      sendsPerDay: 1.5,
      segments: [
        { sends: 2, sendsPerDay: 1, stackStart: 0, stackEnd: 1 },
        { sends: 1, sendsPerDay: 0.5, stackStart: 1, stackEnd: 1.5 },
      ],
    });
    expect(chart?.periods[5]).toMatchObject({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      climbingDays: 2,
      sends: 1,
      sendsPerDay: 0.5,
      segments: [
        { sends: 0, sendsPerDay: 0, stackStart: 0, stackEnd: 0 },
        { sends: 1, sendsPerDay: 0.5, stackStart: 0, stackEnd: 0.5 },
      ],
    });
  });

  it("returns no chart when there are no graded observations", () => {
    expect(buildClimbingGradeProgression([])).toBeNull();
  });
});
