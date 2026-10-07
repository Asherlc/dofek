import type { ClimbingGradeProgressionLane } from "@dofek/training/climbing-progression";

export const climbingProgressionFixture: ClimbingGradeProgressionLane = {
  style: "boulder",
  climbType: "boulder",
  gradeSystem: "v_scale",
  grades: [{ grade: "V4", gradeSortValue: 65 }],
  settings: ["indoor"],
  axisMax: 3,
  axisInterval: 1,
  axisTicks: [0, 1, 2, 3],
  periods: [
    {
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      settings: [
        {
          setting: "indoor",
          climbingDays: 2,
          sends: 4,
          unknownOutcomes: 0,
          sendsPerDay: 2,
          segments: [{ grade: "V4", sends: 4, sendsPerDay: 2, stackStart: 0, stackEnd: 2 }],
        },
      ],
    },
  ],
};
