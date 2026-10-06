import { describe, expect, it } from "vitest";
import {
  buildClimbingGradeProgression,
  type ClimbingProgressionEntry,
} from "./climbing-grade-progression.ts";

const boulderEntry: ClimbingProgressionEntry = {
  date: "2026-01-02",
  style: "boulder",
  climbType: "boulder",
  setting: "indoor",
  gradeSystem: "v_scale",
  grade: "V4",
  gradeSortValue: 65,
  sent: true,
};

describe("buildClimbingGradeProgression", () => {
  it("keeps a visible zero baseline when all outcomes are failed or unknown", () => {
    const [lane] = buildClimbingGradeProgression([
      { ...boulderEntry, sent: false },
      { ...boulderEntry, date: "2026-03-02", sent: null },
    ]);

    expect(lane).toMatchObject({
      axisMax: 1,
      axisInterval: 1,
      axisTicks: [0, 1],
      periods: [
        {
          startDate: "2026-01-01",
          settings: [
            {
              climbingDays: 1,
              sends: 0,
              unknownOutcomes: 0,
              sendsPerDay: 0,
              segments: [{ grade: "V4", sends: 0, stackStart: 0, stackEnd: 0 }],
            },
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
          ],
        },
        {
          startDate: "2026-03-01",
          settings: [{ climbingDays: 1, sends: 0, unknownOutcomes: 1, sendsPerDay: 0 }],
        },
      ],
    });
  });

  it("keeps retained grade scales in separate lanes with a stable order", () => {
    const lanes = buildClimbingGradeProgression([
      boulderEntry,
      {
        ...boulderEntry,
        gradeSystem: "font",
        grade: "6A",
        gradeSortValue: 60,
        setting: "outdoor",
      },
    ]);

    expect(lanes).toMatchObject([
      {
        style: "boulder",
        gradeSystem: "font",
        grades: [{ grade: "6A", gradeSortValue: 60 }],
        settings: ["outdoor"],
        periods: [{ settings: [{ climbingDays: 1, sends: 1, sendsPerDay: 1 }] }],
      },
      {
        style: "boulder",
        gradeSystem: "v_scale",
        grades: [{ grade: "V4", gradeSortValue: 65 }],
        settings: ["indoor"],
        periods: [{ settings: [{ climbingDays: 1, sends: 1, sendsPerDay: 1 }] }],
      },
    ]);
  });

  it("orders tied grades by label and preserves each grade's stack", () => {
    const routeEntry: ClimbingProgressionEntry = {
      ...boulderEntry,
      style: "lead",
      climbType: "route",
      gradeSystem: "yds",
      grade: "5.10a",
      gradeSortValue: 61,
    };
    const [lane] = buildClimbingGradeProgression([routeEntry, { ...routeEntry, grade: "5.10" }]);

    expect(lane?.grades).toEqual([
      { grade: "5.10", gradeSortValue: 61 },
      { grade: "5.10a", gradeSortValue: 61 },
    ]);
    expect(lane?.periods[0]?.settings[0]).toMatchObject({
      climbingDays: 1,
      sends: 2,
      sendsPerDay: 2,
      segments: [
        { grade: "5.10", sends: 1, sendsPerDay: 1, stackStart: 0, stackEnd: 1 },
        { grade: "5.10a", sends: 1, sendsPerDay: 1, stackStart: 1, stackEnd: 2 },
      ],
    });
  });

  it("places sends in the correct multi-month bins and scales every stack by recorded days", () => {
    const [lane] = buildClimbingGradeProgression([
      { ...boulderEntry, date: "2025-01-31", grade: "V3", gradeSortValue: 61 },
      { ...boulderEntry, date: "2025-02-01", grade: "V3", gradeSortValue: 61 },
      { ...boulderEntry, date: "2025-02-01" },
      { ...boulderEntry, date: "2026-04-01" },
      { ...boulderEntry, date: "2026-04-03", sent: false },
    ]);

    expect(lane).toMatchObject({ axisMax: 3, axisInterval: 1, axisTicks: [0, 1, 2, 3] });
    expect(lane?.periods).toHaveLength(6);
    expect(lane?.periods[0]).toMatchObject({
      startDate: "2025-01-01",
      endDate: "2025-03-31",
      settings: [
        {
          climbingDays: 2,
          sends: 3,
          sendsPerDay: 1.5,
          segments: [
            { grade: "V3", sends: 2, sendsPerDay: 1, stackStart: 0, stackEnd: 1 },
            { grade: "V4", sends: 1, sendsPerDay: 0.5, stackStart: 1, stackEnd: 1.5 },
          ],
        },
      ],
    });
    expect(lane?.periods[5]).toMatchObject({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      settings: [
        {
          climbingDays: 2,
          sends: 1,
          sendsPerDay: 0.5,
          segments: [
            { grade: "V3", sends: 0, sendsPerDay: 0, stackStart: 0, stackEnd: 0 },
            { grade: "V4", sends: 1, sendsPerDay: 0.5, stackStart: 0, stackEnd: 0.5 },
          ],
        },
      ],
    });
  });
});
