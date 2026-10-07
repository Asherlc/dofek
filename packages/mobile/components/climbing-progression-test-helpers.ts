import type { ClimbingGradeProgressionLane } from "@dofek/training/climbing-progression";

export function climbingProgressionFixture(
  style: ClimbingGradeProgressionLane["style"] = "boulder",
): ClimbingGradeProgressionLane {
  const grade = style === "boulder" ? "V4" : "5.11a";
  return {
    style,
    climbType: style === "boulder" ? "boulder" : "route",
    gradeSystem: style === "boulder" ? "v_scale" : "yds",
    grades: [{ grade, gradeSortValue: 65 }],
    settings: ["indoor", "outdoor"],
    axisMax: 3,
    axisInterval: 1,
    axisTicks: [0, 1, 2, 3],
    periods: [
      {
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        settings: [
          {
            setting: "indoor",
            climbingDays: 2,
            sends: 4,
            unknownOutcomes: 0,
            sendsPerDay: 2,
            segments: [{ grade, sends: 4, sendsPerDay: 2, stackStart: 0, stackEnd: 2 }],
          },
          {
            setting: "outdoor",
            climbingDays: 1,
            sends: 0,
            unknownOutcomes: 0,
            sendsPerDay: 0,
            segments: [{ grade, sends: 0, sendsPerDay: 0, stackStart: 0, stackEnd: 0 }],
          },
        ],
      },
      {
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        settings: [
          {
            setting: "indoor",
            climbingDays: 0,
            sends: 0,
            unknownOutcomes: 0,
            sendsPerDay: null,
            segments: [{ grade, sends: 0, sendsPerDay: null, stackStart: null, stackEnd: null }],
          },
          {
            setting: "outdoor",
            climbingDays: 0,
            sends: 0,
            unknownOutcomes: 0,
            sendsPerDay: null,
            segments: [{ grade, sends: 0, sendsPerDay: null, stackStart: null, stackEnd: null }],
          },
        ],
      },
    ],
  };
}
