import type { ClimbingGradeProgressionData } from "@dofek/training/climbing-progression";

export function climbingProgressionFixture(
  overrides: Partial<ClimbingGradeProgressionData> = {},
): ClimbingGradeProgressionData {
  return {
    grades: [
      {
        key: "boulder-v4",
        climbKind: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        gradeSortValue: 65,
      },
      {
        key: "route-5.11a",
        climbKind: "route",
        gradeSystem: "yds",
        grade: "5.11a",
        gradeSortValue: 65,
      },
    ],
    axisMax: 3,
    axisInterval: 1,
    axisTicks: [0, 1, 2, 3],
    periods: [
      {
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        climbingDays: 3,
        sends: 6,
        unknownOutcomes: 0,
        sendsPerDay: 2,
        segments: [
          { gradeKey: "boulder-v4", sends: 4, sendsPerDay: 4 / 3, stackStart: 0, stackEnd: 4 / 3 },
          { gradeKey: "route-5.11a", sends: 2, sendsPerDay: 2 / 3, stackStart: 4 / 3, stackEnd: 2 },
        ],
      },
      {
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        climbingDays: 1,
        sends: 0,
        unknownOutcomes: 0,
        sendsPerDay: 0,
        segments: [
          { gradeKey: "boulder-v4", sends: 0, sendsPerDay: 0, stackStart: 0, stackEnd: 0 },
          { gradeKey: "route-5.11a", sends: 0, sendsPerDay: 0, stackStart: 0, stackEnd: 0 },
        ],
      },
      {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        climbingDays: 0,
        sends: 0,
        unknownOutcomes: 0,
        sendsPerDay: null,
        segments: [
          { gradeKey: "boulder-v4", sends: 0, sendsPerDay: null, stackStart: null, stackEnd: null },
          {
            gradeKey: "route-5.11a",
            sends: 0,
            sendsPerDay: null,
            stackStart: null,
            stackEnd: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}
