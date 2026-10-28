import type {
  ClimbingStrengths,
  ClimbingStrengthsCell,
  ClimbingStrengthsPanel,
} from "@dofek/training/climbing-strengths";

function cell(
  grade: string,
  sends: number,
  climbs: number,
  successRate: number | null,
  differencePercentagePoints: number | null,
  sampleStatus: ClimbingStrengthsCell["sampleStatus"],
): ClimbingStrengthsCell {
  return {
    grade,
    unknownOutcomes: 0,
    sends,
    climbs,
    successRate,
    differencePercentagePoints,
    sampleStatus,
    examples: [],
  };
}

export const climbingStrengthsFixture: ClimbingStrengths = {
  coverage: { unknownOutcomes: 2, missingGrades: 1, missingIdentity: 3 },
  panels: [
    {
      key: "boulder-angle-indoor",
      contextKey: "boulder",
      contextLabel: "Bouldering",
      dimension: "wall_angle",
      setting: "indoor",
      gradeAdjustedStrengths: [],
      allGrades: {
        grades: [
          {
            grade: "All grades",
            gradeSortValue: 0,
            unknownOutcomes: 0,
            sends: 34,
            climbs: 63,
            successRate: 54,
          },
        ],
        rows: [
          {
            key: "vertical",
            label: "Vertical",
            cells: [cell("All grades", 13, 21, 62, 8, "available")],
          },
          {
            key: "overhang",
            label: "Overhang",
            cells: [cell("All grades", 11, 19, 58, 4, "available")],
          },
          { key: "slab", label: "Slab", cells: [cell("All grades", 10, 23, 43, -11, "available")] },
        ],
        progress: [
          {
            startDate: "2026-08-15",
            endDate: "2026-08-31",
            rows: [
              { key: "vertical", cells: [cell("All grades", 2, 4, 50, null, "limited")] },
              { key: "overhang", cells: [cell("All grades", 1, 3, 33, null, "limited")] },
              { key: "slab", cells: [cell("All grades", 1, 1, 100, null, "limited")] },
            ],
          },
          {
            startDate: "2026-09-01",
            endDate: "2026-09-30",
            rows: [
              { key: "vertical", cells: [cell("All grades", 0, 0, null, null, "no_data")] },
              { key: "overhang", cells: [cell("All grades", 0, 0, null, null, "no_data")] },
              { key: "slab", cells: [cell("All grades", 0, 0, null, null, "no_data")] },
            ],
          },
          {
            startDate: "2026-10-01",
            endDate: "2026-10-26",
            rows: [
              { key: "vertical", cells: [cell("All grades", 13, 21, 62, null, "available")] },
              { key: "overhang", cells: [cell("All grades", 11, 19, 58, null, "available")] },
              { key: "slab", cells: [cell("All grades", 10, 23, 43, null, "available")] },
            ],
          },
        ],
      },
      grades: [
        {
          grade: "V3",
          gradeSortValue: 3,
          unknownOutcomes: 0,
          sends: 24,
          climbs: 30,
          successRate: 80,
        },
        {
          grade: "V4",
          gradeSortValue: 4,
          unknownOutcomes: 0,
          sends: 3,
          climbs: 8,
          successRate: 37.5,
        },
        {
          grade: "V5",
          gradeSortValue: 5,
          unknownOutcomes: 0,
          sends: 6,
          climbs: 20,
          successRate: 30,
        },
        {
          grade: "V6",
          gradeSortValue: 6,
          unknownOutcomes: 0,
          sends: 1,
          climbs: 5,
          successRate: 20,
        },
      ],
      rows: [
        {
          key: "vertical",
          label: "Vertical",
          cells: [
            cell("V3", 8, 10, 80, 0, "available"),
            {
              ...cell("V4", 3, 6, 50, 12.5, "available"),
              examples: [
                {
                  logEntryId: "log-1",
                  activityId: "activity-1",
                  name: "Evening Arete",
                  grade: "V4",
                  date: "2026-10-20",
                  providerId: "kaya",
                  sourceName: "KAYA",
                  sourceUrl: "https://kayaclimb.com/climb/example",
                  outcome: "sent",
                },
              ],
            },
            cell("V5", 2, 5, 40, 10, "available"),
            cell("V6", 0, 0, null, null, "no_data"),
          ],
        },
        {
          key: "overhang",
          label: "Overhang",
          cells: [
            cell("V3", 6, 10, 60, -20, "available"),
            cell("V4", 0, 2, 0, -37.5, "limited"),
            cell("V5", 4, 5, 80, 50, "available"),
            cell("V6", 1, 2, 50, 30, "limited"),
          ],
        },
        {
          key: "slab",
          label: "Slab",
          cells: [
            cell("V3", 10, 10, 100, 20, "available"),
            cell("V4", 0, 0, null, null, "no_data"),
            cell("V5", 0, 10, 0, -30, "available"),
            cell("V6", 0, 3, 0, -20, "limited"),
          ],
        },
      ],
      coverage: { missingTraits: 4, unknownOutcomes: 2 },
      progress: [
        {
          startDate: "2026-08-15",
          endDate: "2026-08-31",
          rows: [
            {
              key: "vertical",
              cells: [
                cell("V3", 2, 3, 66.7, null, "limited"),
                cell("V4", 0, 1, 0, null, "limited"),
                cell("V5", 0, 0, null, null, "no_data"),
                cell("V6", 0, 0, null, null, "no_data"),
              ],
            },
            {
              key: "overhang",
              cells: [
                cell("V3", 1, 2, 50, null, "limited"),
                cell("V4", 0, 1, 0, null, "limited"),
                cell("V5", 0, 0, null, null, "no_data"),
                cell("V6", 0, 0, null, null, "no_data"),
              ],
            },
            {
              key: "slab",
              cells: [
                cell("V3", 1, 1, 100, null, "limited"),
                cell("V4", 0, 0, null, null, "no_data"),
                cell("V5", 0, 0, null, null, "no_data"),
                cell("V6", 0, 0, null, null, "no_data"),
              ],
            },
          ],
        },
        {
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          rows: [
            {
              key: "vertical",
              cells: [
                cell("V3", 0, 0, null, null, "no_data"),
                cell("V4", 0, 0, null, null, "no_data"),
                cell("V5", 0, 0, null, null, "no_data"),
                cell("V6", 0, 0, null, null, "no_data"),
              ],
            },
            {
              key: "overhang",
              cells: [
                cell("V3", 0, 0, null, null, "no_data"),
                cell("V4", 0, 0, null, null, "no_data"),
                cell("V5", 0, 0, null, null, "no_data"),
                cell("V6", 0, 0, null, null, "no_data"),
              ],
            },
            {
              key: "slab",
              cells: [
                cell("V3", 0, 0, null, null, "no_data"),
                cell("V4", 0, 0, null, null, "no_data"),
                cell("V5", 0, 0, null, null, "no_data"),
                cell("V6", 0, 0, null, null, "no_data"),
              ],
            },
          ],
        },
        {
          startDate: "2026-10-01",
          endDate: "2026-10-26",
          rows: [
            {
              key: "vertical",
              cells: [
                cell("V3", 8, 10, 80, null, "available"),
                cell("V4", 3, 6, 50, null, "available"),
                cell("V5", 2, 5, 40, null, "available"),
                cell("V6", 0, 0, null, null, "no_data"),
              ],
            },
            {
              key: "overhang",
              cells: [
                cell("V3", 6, 10, 60, null, "available"),
                cell("V4", 0, 2, 0, null, "limited"),
                cell("V5", 4, 5, 80, null, "available"),
                cell("V6", 1, 2, 50, null, "limited"),
              ],
            },
            {
              key: "slab",
              cells: [
                cell("V3", 10, 10, 100, null, "available"),
                cell("V4", 0, 0, null, null, "no_data"),
                cell("V5", 0, 10, 0, null, "available"),
                cell("V6", 0, 3, 0, null, "limited"),
              ],
            },
          ],
        },
      ],
    },
  ],
};

const unknownBase = climbingStrengthsFixture.panels[0];
if (!unknownBase) throw new Error("Missing climbing strengths panel");
const unknownRow = unknownBase.rows[0];
const unknownExample = unknownRow?.cells.flatMap((cell) => cell.examples)[0];
if (!unknownRow || !unknownExample) throw new Error("Missing climbing strengths examples");
const unknownCells: ClimbingStrengthsPanel["rows"][number]["cells"] = [
  {
    grade: "V3",
    sends: 0,
    climbs: 4,
    unknownOutcomes: 4,
    successRate: null,
    differencePercentagePoints: null,
    sampleStatus: "limited",
    examples: [
      {
        ...unknownExample,
        logEntryId: "log-unknown-v3",
        name: "Unknown ascent",
        grade: "V3",
        outcome: null,
      },
    ],
  },
  {
    grade: "V4",
    sends: 2,
    climbs: 5,
    unknownOutcomes: 2,
    successRate: 67,
    differencePercentagePoints: 0,
    sampleStatus: "available",
    examples: [
      {
        ...unknownExample,
        logEntryId: "log-known-v4",
        name: "Known ascent",
        grade: "V4",
        outcome: "sent",
      },
    ],
  },
];
const unknownPooled = {
  grade: "All grades",
  sends: 2,
  climbs: 9,
  unknownOutcomes: 6,
  successRate: 67,
  differencePercentagePoints: 0,
  sampleStatus: "available" as const,
  examples: unknownCells.flatMap((cell) => cell.examples),
};
export const climbingStrengthsUnknownResultsFixture: ClimbingStrengths = {
  coverage: { unknownOutcomes: 6, missingGrades: 0, missingIdentity: 0 },
  panels: [
    {
      ...unknownBase,
      grades: unknownCells.map((cell, index) => ({ ...cell, gradeSortValue: index })),
      rows: [{ key: "vertical", label: "Vertical", cells: unknownCells }],
      progress: [
        {
          startDate: "2026-10-01",
          endDate: "2026-10-26",
          rows: [{ key: "vertical", cells: unknownCells }],
        },
      ],
      gradeAdjustedStrengths: [],
      allGrades: {
        grades: [{ ...unknownPooled, gradeSortValue: 0 }],
        rows: [{ key: "vertical", label: "Vertical", cells: [unknownPooled] }],
        progress: [
          {
            startDate: "2026-10-01",
            endDate: "2026-10-26",
            rows: [{ key: "vertical", cells: [unknownPooled] }],
          },
        ],
      },
    },
  ],
};

// Precomputed server response values; fixtures do not calculate metrics in the client.
(
  [
    [
      {
        key: "vertical",
        expectedSuccessRate: 56,
        differencePercentagePoints: 6,
        sampleStatus: "available",
      },
      {
        key: "overhang",
        expectedSuccessRate: 56.1,
        differencePercentagePoints: 1.8,
        sampleStatus: "available",
      },
      {
        key: "slab",
        expectedSuccessRate: 50.4,
        differencePercentagePoints: -7,
        sampleStatus: "available",
      },
    ],
  ] satisfies ClimbingStrengthsPanel["gradeAdjustedStrengths"][]
).forEach((summary, index) => {
  const panel = climbingStrengthsFixture.panels[index];
  if (!panel) throw new Error("Missing strengths fixture panel");
  panel.gradeAdjustedStrengths = summary;
});
(
  [
    [
      {
        key: "vertical",
        expectedSuccessRate: 66.7,
        differencePercentagePoints: 0,
        sampleStatus: "limited",
      },
    ],
  ] satisfies ClimbingStrengthsPanel["gradeAdjustedStrengths"][]
).forEach((summary, index) => {
  const panel = climbingStrengthsUnknownResultsFixture.panels[index];
  if (!panel) throw new Error("Missing strengths fixture panel");
  panel.gradeAdjustedStrengths = summary;
});
