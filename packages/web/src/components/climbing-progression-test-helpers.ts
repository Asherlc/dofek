import type { ClimbingGradeProgressionData } from "@dofek/training/climbing-progression";

/** Hand-authored combined server response, including zero and unrecorded periods. */
export function climbingProgressionFixture(): ClimbingGradeProgressionData {
  const grades: ClimbingGradeProgressionData["grades"] = [
    {
      key: "boulder:v_scale:V2",
      climbKind: "boulder",
      gradeSystem: "v_scale",
      grade: "V2",
      gradeSortValue: 55,
    },
    {
      key: "boulder:v_scale:V4",
      climbKind: "boulder",
      gradeSystem: "v_scale",
      grade: "V4",
      gradeSortValue: 65,
    },
    {
      key: "route:yds:5.9",
      climbKind: "route",
      gradeSystem: "yds",
      grade: "5.9",
      gradeSortValue: 55,
    },
    {
      key: "route:yds:5.11a",
      climbKind: "route",
      gradeSystem: "yds",
      grade: "5.11a",
      gradeSortValue: 65,
    },
  ];
  return {
    grades,
    axisMax: 6,
    axisInterval: 2,
    axisTicks: [0, 2, 4, 6],
    periods: [
      {
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        climbingDays: 5,
        sends: 20,
        unknownOutcomes: 0,
        sendsPerDay: 4,
        segments: grades.map(({ key }, index) => ({
          gradeKey: key,
          sends: 5,
          sendsPerDay: 1,
          stackStart: index,
          stackEnd: index + 1,
        })),
      },
      {
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        climbingDays: 4,
        sends: 0,
        unknownOutcomes: 1,
        sendsPerDay: 0,
        segments: grades.map(({ key }) => ({
          gradeKey: key,
          sends: 0,
          sendsPerDay: 0,
          stackStart: 0,
          stackEnd: 0,
        })),
      },
      {
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        climbingDays: 0,
        sends: 0,
        unknownOutcomes: 0,
        sendsPerDay: null,
        segments: grades.map(({ key }) => ({
          gradeKey: key,
          sends: 0,
          sendsPerDay: null,
          stackStart: null,
          stackEnd: null,
        })),
      },
    ],
  };
}
