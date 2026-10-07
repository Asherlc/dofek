import type { ClimbingGradeProgressionLane } from "@dofek/training/climbing-progression";

/** Hand-authored server response, including zero sends and unrecorded months. */
export function climbingProgressionFixture(
  style: ClimbingGradeProgressionLane["style"] = "boulder",
): ClimbingGradeProgressionLane {
  const grades = style === "boulder" ? ["V2", "V4"] : ["5.9", "5.11a"];
  const [lower = "V2", higher = "V4"] = grades;
  return {
    style,
    climbType: style === "boulder" ? "boulder" : "route",
    gradeSystem: style === "boulder" ? "v_scale" : "yds",
    grades: [
      { grade: lower, gradeSortValue: 55 },
      { grade: higher, gradeSortValue: 65 },
    ],
    settings: ["indoor", "outdoor"],
    axisMax: 6,
    axisInterval: 2,
    axisTicks: [0, 2, 4, 6],
    periods: [
      {
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        settings: [
          {
            setting: "indoor",
            climbingDays: 4,
            sends: 16,
            unknownOutcomes: 0,
            sendsPerDay: 4,
            segments: [
              { grade: lower, sends: 12, sendsPerDay: 3, stackStart: 0, stackEnd: 3 },
              { grade: higher, sends: 4, sendsPerDay: 1, stackStart: 3, stackEnd: 4 },
            ],
          },
          {
            setting: "outdoor",
            climbingDays: 2,
            sends: 4,
            unknownOutcomes: 0,
            sendsPerDay: 2,
            segments: [
              { grade: lower, sends: 2, sendsPerDay: 1, stackStart: 0, stackEnd: 1 },
              { grade: higher, sends: 2, sendsPerDay: 1, stackStart: 1, stackEnd: 2 },
            ],
          },
        ],
      },
      {
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        settings: [
          {
            setting: "indoor",
            climbingDays: 4,
            sends: 16,
            unknownOutcomes: 0,
            sendsPerDay: 4,
            segments: [
              { grade: lower, sends: 2, sendsPerDay: 0.5, stackStart: 0, stackEnd: 0.5 },
              { grade: higher, sends: 14, sendsPerDay: 3.5, stackStart: 0.5, stackEnd: 4 },
            ],
          },
          {
            setting: "outdoor",
            climbingDays: 1,
            sends: 0,
            unknownOutcomes: 0,
            sendsPerDay: 0,
            segments: [
              { grade: lower, sends: 0, sendsPerDay: 0, stackStart: 0, stackEnd: 0 },
              { grade: higher, sends: 0, sendsPerDay: 0, stackStart: 0, stackEnd: 0 },
            ],
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
            segments: [
              { grade: lower, sends: 0, sendsPerDay: null, stackStart: null, stackEnd: null },
              { grade: higher, sends: 0, sendsPerDay: null, stackStart: null, stackEnd: null },
            ],
          },
          {
            setting: "outdoor",
            climbingDays: 0,
            sends: 0,
            unknownOutcomes: 0,
            sendsPerDay: null,
            segments: [
              { grade: lower, sends: 0, sendsPerDay: null, stackStart: null, stackEnd: null },
              { grade: higher, sends: 0, sendsPerDay: null, stackStart: null, stackEnd: null },
            ],
          },
        ],
      },
    ],
  };
}
