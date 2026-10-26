import type { ClimbingStrengths, ClimbingStrengthsPanel } from "@dofek/training/climbing-strengths";

// V3 baseline includes four climbs (two sent) without a recorded wall/hold trait.
const angle: ClimbingStrengthsPanel = {
  key: "boulder-indoor-angle",
  contextKey: "boulder-v",
  contextLabel: "Bouldering · V scale · Free",
  dimension: "wall_angle",
  setting: "indoor",
  grades: [
    { grade: "V3", gradeSortValue: 3, sends: 4, climbs: 9, successRate: 44 },
    { grade: "V4", gradeSortValue: 4, sends: 1, climbs: 5, successRate: 20 },
  ],
  rows: [
    {
      key: "slab",
      label: "Slab",
      cells: [
        {
          grade: "V3",
          sends: 2,
          climbs: 5,
          successRate: 40,
          differencePercentagePoints: -4,
          sampleStatus: "available",
          examples: [
            {
              logEntryId: "log-1",
              activityId: "activity-1",
              name: "Quiet Feet",
              grade: "V3",
              date: "2026-10-10",
              providerId: "mountain_project",
              sourceName: "Mountain Project",
              sourceUrl: "https://www.mountainproject.com/route/1",
              outcome: "sent",
            },
          ],
        },
        {
          grade: "V4",
          sends: 0,
          climbs: 2,
          successRate: 0,
          differencePercentagePoints: -20,
          sampleStatus: "limited",
          examples: [],
        },
      ],
    },
    {
      key: "vertical",
      label: "Vertical",
      cells: [
        {
          grade: "V3",
          sends: 0,
          climbs: 0,
          successRate: null,
          differencePercentagePoints: null,
          sampleStatus: "no_data",
          examples: [],
        },
        {
          grade: "V4",
          sends: 1,
          climbs: 3,
          successRate: 33,
          differencePercentagePoints: 13,
          sampleStatus: "limited",
          examples: [],
        },
      ],
    },
  ],
  coverage: { missingTraits: 7, unknownOutcomes: 2 },
};
export const climbingStrengthsFixture: ClimbingStrengths = {
  panels: [
    angle,
    {
      ...angle,
      key: "boulder-indoor-holds",
      dimension: "hold_type",
      rows: angle.rows.map((row) => ({
        ...row,
        key: `hold-${row.key}`,
        label: row.key === "slab" ? "Crimps" : "Slopers",
      })),
    },
    {
      ...angle,
      key: "boulder-setting",
      dimension: "setting",
      setting: null,
      grades: [
        { grade: "V3", gradeSortValue: 3, sends: 6, climbs: 13, successRate: 46 },
        { grade: "V4", gradeSortValue: 4, sends: 1, climbs: 5, successRate: 20 },
      ],
      rows: [
        {
          key: "indoor",
          label: "Indoor",
          cells: [
            {
              grade: "V3",
              sends: 4,
              climbs: 9,
              successRate: 44,
              differencePercentagePoints: -2,
              sampleStatus: "available",
              examples: [],
            },
            {
              grade: "V4",
              sends: 1,
              climbs: 5,
              successRate: 20,
              differencePercentagePoints: 0,
              sampleStatus: "available",
              examples: [],
            },
          ],
        },
        {
          key: "outdoor",
          label: "Outdoor",
          cells: [
            {
              grade: "V3",
              sends: 2,
              climbs: 4,
              successRate: 50,
              differencePercentagePoints: 4,
              sampleStatus: "limited",
              examples: [],
            },
            {
              grade: "V4",
              sends: 0,
              climbs: 0,
              successRate: null,
              differencePercentagePoints: null,
              sampleStatus: "no_data",
              examples: [],
            },
          ],
        },
      ],
    },
    {
      ...angle,
      key: "route-outdoor-angle",
      contextKey: "route-yds-lead",
      contextLabel: "Routes · YDS · Lead · Free",
      setting: "outdoor",
      grades: angle.grades.map((grade) => ({
        ...grade,
        grade: grade.grade === "V3" ? "5.10a" : "5.10b",
      })),
      rows: angle.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => ({
          ...cell,
          grade: cell.grade === "V3" ? "5.10a" : "5.10b",
          examples: [],
        })),
      })),
    },
  ],
  coverage: { unknownOutcomes: 3, missingGrades: 2, missingIdentity: 1 },
};
