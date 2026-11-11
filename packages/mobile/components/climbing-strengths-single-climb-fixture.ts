import type { ClimbingStrengths, ClimbingStrengthsCell } from "@dofek/training/climbing-strengths";
import { climbingStrengthsFixture } from "./climbing-strengths-fixtures";

const panel = climbingStrengthsFixture.panels[0];
if (!panel) throw new Error("Missing climbing strengths fixture panel");
const singleClimbCell: ClimbingStrengthsCell = {
  grade: "V3",
  sends: 1,
  climbs: 1,
  unknownOutcomes: 0,
  successRate: 100,
  differencePercentagePoints: 0,
  sampleStatus: "limited",
  examples: [
    {
      logEntryId: "log-single",
      activityId: "activity-single",
      name: "Quiet Feet",
      grade: "V3",
      date: "2026-10-10",
      providerId: "mountain_project",
      sourceName: "Mountain Project",
      sourceUrl: "https://www.mountainproject.com/route/1",
      outcome: "sent",
    },
  ],
};
export const climbingStrengthsSingleClimbFixture: ClimbingStrengths = {
  coverage: { unknownOutcomes: 0, missingGrades: 0, missingIdentity: 0 },
  panels: [
    {
      ...panel,
      grades: [
        {
          grade: "V3",
          gradeSortValue: 3,
          sends: 1,
          climbs: 1,
          unknownOutcomes: 0,
          successRate: 100,
        },
      ],
      rows: [{ key: "slab", label: "Slab", cells: [singleClimbCell] }],
      progress: [],
      allGrades: {
        grades: [
          {
            grade: "All grades",
            gradeSortValue: 0,
            sends: 1,
            climbs: 1,
            unknownOutcomes: 0,
            successRate: 100,
          },
        ],
        rows: [
          {
            key: "slab",
            label: "Slab",
            cells: [{ ...singleClimbCell, grade: "All grades" }],
          },
        ],
        progress: [],
      },
      gradeAdjustedStrengths: [
        {
          key: "slab",
          expectedSuccessRate: 100,
          differencePercentagePoints: 0,
          sampleStatus: "limited",
        },
      ],
      coverage: { unknownOutcomes: 0, missingTraits: 0 },
    },
  ],
};
