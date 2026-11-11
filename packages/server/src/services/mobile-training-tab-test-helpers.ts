import type { ClimbingGradeProgressionData } from "@dofek/training/climbing-progression";
import type { ClimbingGradeProgressionV1Lane } from "@dofek/training/climbing-progression-v1";

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

export const climbingProgressionV1Fixture: ClimbingGradeProgressionV1Lane = {
  attemptScope: "climb",
  ropeMethod: null,
  solo: null,
  usedAid: false,
  climbKind: "boulder",
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
