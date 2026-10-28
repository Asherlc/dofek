import type { ClimbingGradeProgressionData } from "@dofek/training/climbing-progression";

export const climbingProgressionFixture: ClimbingGradeProgressionData = {
  grades: [
    {
      key: '["boulder","v_scale","V4"]',
      climbKind: "boulder",
      gradeSystem: "v_scale",
      grade: "V4",
      gradeSortValue: 65,
    },
  ],
  axisMax: 3,
  axisInterval: 1,
  axisTicks: [0, 1, 2, 3],
  periods: [
    {
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      climbingDays: 2,
      sends: 4,
      unknownOutcomes: 0,
      sendsPerDay: 2,
      segments: [
        {
          gradeKey: '["boulder","v_scale","V4"]',
          sends: 4,
          sendsPerDay: 2,
          stackStart: 0,
          stackEnd: 2,
        },
      ],
    },
  ],
};
