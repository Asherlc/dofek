import type { ClimbingStrengths, ClimbingStrengthsPanel } from "@dofek/training/climbing-strengths";

// V3 baseline includes four climbs (two sent) without a recorded wall/hold trait.
const angle: ClimbingStrengthsPanel = {
  key: "boulder-indoor-angle",
  contextKey: "boulder-v",
  contextLabel: "Bouldering · V scale · Free",
  dimension: "wall_angle",
  setting: "indoor",
  gradeAdjustedStrengths: [],
  allGrades: {
    grades: [
      {
        grade: "All grades",
        gradeSortValue: 0,
        unknownOutcomes: 0,
        sends: 5,
        climbs: 14,
        successRate: 36,
      },
    ],
    rows: [
      {
        key: "slab",
        label: "Slab",
        cells: [
          {
            grade: "All grades",
            unknownOutcomes: 0,
            sends: 2,
            climbs: 7,
            successRate: 29,
            differencePercentagePoints: -7,
            sampleStatus: "available",
            examples: [],
          },
        ],
      },
      {
        key: "vertical",
        label: "Vertical",
        cells: [
          {
            grade: "All grades",
            unknownOutcomes: 0,
            sends: 1,
            climbs: 3,
            successRate: 33,
            differencePercentagePoints: -3,
            sampleStatus: "limited",
            examples: [],
          },
        ],
      },
    ],
    progress: [],
  },
  grades: [
    { grade: "V3", gradeSortValue: 3, unknownOutcomes: 0, sends: 4, climbs: 9, successRate: 44 },
    { grade: "V4", gradeSortValue: 4, unknownOutcomes: 0, sends: 1, climbs: 5, successRate: 20 },
  ],
  rows: [
    {
      key: "slab",
      label: "Slab",
      cells: [
        {
          grade: "V3",
          unknownOutcomes: 0,
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
          unknownOutcomes: 0,
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
          unknownOutcomes: 0,
          sends: 0,
          climbs: 0,
          successRate: null,
          differencePercentagePoints: null,
          sampleStatus: "no_data",
          examples: [],
        },
        {
          grade: "V4",
          unknownOutcomes: 0,
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
  progress: [],
  coverage: { missingTraits: 7, unknownOutcomes: 2 },
};
export const climbingStrengthsFixture: ClimbingStrengths = {
  panels: (
    [
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
        gradeAdjustedStrengths: [],
        allGrades: {
          grades: [
            {
              grade: "All grades",
              gradeSortValue: 0,
              unknownOutcomes: 0,
              sends: 7,
              climbs: 18,
              successRate: 39,
            },
          ],
          rows: [
            {
              key: "indoor",
              label: "Indoor",
              cells: [
                {
                  grade: "All grades",
                  unknownOutcomes: 0,
                  sends: 5,
                  climbs: 14,
                  successRate: 36,
                  differencePercentagePoints: -3,
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
                  grade: "All grades",
                  unknownOutcomes: 0,
                  sends: 2,
                  climbs: 4,
                  successRate: 50,
                  differencePercentagePoints: 11,
                  sampleStatus: "limited",
                  examples: [],
                },
              ],
            },
          ],
          progress: [],
        },
        grades: [
          {
            grade: "V3",
            gradeSortValue: 3,
            unknownOutcomes: 0,
            sends: 6,
            climbs: 13,
            successRate: 46,
          },
          {
            grade: "V4",
            gradeSortValue: 4,
            unknownOutcomes: 0,
            sends: 1,
            climbs: 5,
            successRate: 20,
          },
        ],
        rows: [
          {
            key: "indoor",
            label: "Indoor",
            cells: [
              {
                grade: "V3",
                unknownOutcomes: 0,
                sends: 4,
                climbs: 9,
                successRate: 44,
                differencePercentagePoints: -2,
                sampleStatus: "available",
                examples: [],
              },
              {
                grade: "V4",
                unknownOutcomes: 0,
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
                unknownOutcomes: 0,
                sends: 2,
                climbs: 4,
                successRate: 50,
                differencePercentagePoints: 4,
                sampleStatus: "limited",
                examples: [],
              },
              {
                grade: "V4",
                unknownOutcomes: 0,
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
    ] satisfies ClimbingStrengthsPanel[]
  ).map((panel) => ({
    ...panel,
    gradeAdjustedStrengths: [],
    allGrades: {
      ...panel.allGrades,
      rows: panel.allGrades.rows.map((row, index) => ({
        ...row,
        key: panel.rows[index]?.key ?? row.key,
        label: panel.rows[index]?.label ?? row.label,
      })),
      progress: [
        { startDate: "2026-08-15", endDate: "2026-08-31" },
        { startDate: "2026-09-01", endDate: "2026-09-30" },
        { startDate: "2026-10-01", endDate: "2026-10-26" },
      ].map((period, index) => ({
        ...period,
        rows: panel.allGrades.rows.map((row, rowIndex) => ({
          key: panel.rows[rowIndex]?.key ?? row.key,
          cells: row.cells.map((cell) =>
            index === 2
              ? cell
              : {
                  ...cell,
                  unknownOutcomes: 0,
                  sends: 0,
                  climbs: 0,
                  successRate: null,
                  sampleStatus: "no_data" as const,
                },
          ),
        })),
      })),
    },
    progress: [
      {
        startDate: "2026-08-15",
        endDate: "2026-08-31",
        rows: panel.rows.map((row) => ({
          key: row.key,
          cells: row.cells.map((cell) => ({
            grade: cell.grade,
            unknownOutcomes: 0,
            sends: 0,
            climbs: 0,
            successRate: null,
            sampleStatus: "no_data" as const,
          })),
        })),
      },
      {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        rows: panel.rows.map((row) => ({
          key: row.key,
          cells: row.cells.map((cell) => ({
            grade: cell.grade,
            unknownOutcomes: 0,
            sends: 0,
            climbs: 0,
            successRate: null,
            sampleStatus: "no_data" as const,
          })),
        })),
      },
      {
        startDate: "2026-10-01",
        endDate: "2026-10-26",
        rows: panel.rows.map((row) => ({
          key: row.key,
          cells: row.cells.map(({ grade, sends, climbs, successRate, sampleStatus }) => ({
            grade,
            unknownOutcomes: 0,
            sends,
            climbs,
            successRate,
            sampleStatus,
          })),
        })),
      },
    ],
  })),
  coverage: { unknownOutcomes: 3, missingGrades: 2, missingIdentity: 1 },
};

// A shared comparison fixture keeps each visualization on the same recorded angle groups.
const comparisonPanel = climbingStrengthsFixture.panels[0];
if (!comparisonPanel) throw new Error("Missing climbing strengths comparison panel");
const comparisonFirstRow = comparisonPanel.rows[0];
if (!comparisonFirstRow) throw new Error("Missing comparison row");
const comparisonRows: ClimbingStrengthsPanel["rows"] = [
  {
    ...comparisonFirstRow,
    key: "angle-0",
    label: "0°",
    cells: comparisonFirstRow.cells.map((cell) =>
      cell.grade === "V3" ? { ...cell, differencePercentagePoints: 0 } : cell,
    ),
  },
  {
    key: "angle-20",
    label: "20°",
    cells: [
      {
        grade: "V3",
        unknownOutcomes: 0,
        sends: 3,
        climbs: 5,
        successRate: 60,
        differencePercentagePoints: 20,
        sampleStatus: "available",
        examples: [],
      },
      {
        grade: "V4",
        unknownOutcomes: 0,
        sends: 1,
        climbs: 3,
        successRate: 33,
        differencePercentagePoints: 13,
        sampleStatus: "limited",
        examples: [],
      },
    ],
  },
  {
    key: "angle-40",
    label: "40°",
    cells: [
      {
        grade: "V3",
        unknownOutcomes: 0,
        sends: 1,
        climbs: 5,
        successRate: 20,
        differencePercentagePoints: -20,
        sampleStatus: "available",
        examples: [],
      },
      {
        grade: "V4",
        unknownOutcomes: 0,
        sends: 0,
        climbs: 0,
        successRate: null,
        differencePercentagePoints: null,
        sampleStatus: "no_data",
        examples: [],
      },
    ],
  },
];
export const climbingStrengthsComparisonFixture: ClimbingStrengths = {
  ...climbingStrengthsFixture,
  panels: [
    {
      ...comparisonPanel,
      grades: comparisonPanel.grades.map((grade) =>
        grade.grade === "V3"
          ? { ...grade, unknownOutcomes: 0, sends: 6, climbs: 15, successRate: 40 }
          : grade,
      ),
      coverage: { ...comparisonPanel.coverage, missingTraits: 0 },
      rows: comparisonRows,
      progress: [
        {
          startDate: "2026-08-15",
          endDate: "2026-08-31",
          rows: comparisonRows.map((row) => ({
            key: row.key,
            cells: row.cells.map((cell) => ({
              grade: cell.grade,
              unknownOutcomes: 0,
              sends: 0,
              climbs: 0,
              successRate: null,
              sampleStatus: "no_data",
            })),
          })),
        },
        {
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          rows: [
            {
              key: "angle-0",
              cells: [
                {
                  grade: "V3",
                  unknownOutcomes: 0,
                  sends: 0,
                  climbs: 2,
                  successRate: 0,
                  sampleStatus: "limited",
                },
                {
                  grade: "V4",
                  unknownOutcomes: 0,
                  sends: 0,
                  climbs: 1,
                  successRate: 0,
                  sampleStatus: "limited",
                },
              ],
            },
            {
              key: "angle-20",
              cells: [
                {
                  grade: "V3",
                  unknownOutcomes: 0,
                  sends: 1,
                  climbs: 3,
                  successRate: 33,
                  sampleStatus: "limited",
                },
                {
                  grade: "V4",
                  unknownOutcomes: 0,
                  sends: 0,
                  climbs: 0,
                  successRate: null,
                  sampleStatus: "no_data",
                },
              ],
            },
            {
              key: "angle-40",
              cells: [
                {
                  grade: "V3",
                  unknownOutcomes: 0,
                  sends: 1,
                  climbs: 5,
                  successRate: 20,
                  sampleStatus: "available",
                },
                {
                  grade: "V4",
                  unknownOutcomes: 0,
                  sends: 0,
                  climbs: 0,
                  successRate: null,
                  sampleStatus: "no_data",
                },
              ],
            },
          ],
        },
        {
          startDate: "2026-10-01",
          endDate: "2026-10-26",
          rows: comparisonRows.map((row) => ({
            key: row.key,
            cells: row.cells.map(({ grade, sends, climbs, successRate, sampleStatus }) => ({
              grade,
              unknownOutcomes: 0,
              sends,
              climbs,
              successRate,
              sampleStatus,
            })),
          })),
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
        key: "angle-0",
        expectedSuccessRate: 34.3,
        differencePercentagePoints: -5.7,
        sampleStatus: "available",
      },
      {
        key: "angle-20",
        expectedSuccessRate: 32.5,
        differencePercentagePoints: 17.5,
        sampleStatus: "available",
      },
      {
        key: "angle-40",
        expectedSuccessRate: 40,
        differencePercentagePoints: -20,
        sampleStatus: "available",
      },
    ],
  ] satisfies ClimbingStrengthsPanel["gradeAdjustedStrengths"][]
).forEach((summary, index) => {
  const panel = climbingStrengthsComparisonFixture.panels[index];
  if (!panel) throw new Error("Missing strengths fixture panel");
  panel.gradeAdjustedStrengths = summary;
});
(
  [
    [
      {
        key: "slab",
        expectedSuccessRate: 37.5,
        differencePercentagePoints: -8.9,
        sampleStatus: "available",
      },
      {
        key: "vertical",
        expectedSuccessRate: 20,
        differencePercentagePoints: 13.3,
        sampleStatus: "limited",
      },
    ],
    [
      {
        key: "hold-slab",
        expectedSuccessRate: 37.5,
        differencePercentagePoints: -8.9,
        sampleStatus: "available",
      },
      {
        key: "hold-vertical",
        expectedSuccessRate: 20,
        differencePercentagePoints: 13.3,
        sampleStatus: "limited",
      },
    ],
    [
      {
        key: "indoor",
        expectedSuccessRate: 36.8,
        differencePercentagePoints: -1.1,
        sampleStatus: "available",
      },
      {
        key: "outdoor",
        expectedSuccessRate: 46.2,
        differencePercentagePoints: 3.8,
        sampleStatus: "limited",
      },
    ],
    [
      {
        key: "slab",
        expectedSuccessRate: 37.5,
        differencePercentagePoints: -8.9,
        sampleStatus: "available",
      },
      {
        key: "vertical",
        expectedSuccessRate: 20,
        differencePercentagePoints: 13.3,
        sampleStatus: "limited",
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

const pooledComparison = climbingStrengthsComparisonFixture.panels[0];
if (!pooledComparison) throw new Error("Missing comparison fixture");
pooledComparison.allGrades = {
  grades: [
    {
      grade: "All grades",
      sends: 7,
      climbs: 20,
      unknownOutcomes: 0,
      successRate: 35,
      gradeSortValue: 0,
    },
  ],
  rows: [
    {
      key: "angle-0",
      label: "0°",
      cells: [
        {
          grade: "All grades",
          sends: 2,
          climbs: 7,
          unknownOutcomes: 0,
          successRate: 29,
          sampleStatus: "available",
          differencePercentagePoints: -6,
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
      ],
    },
    {
      key: "angle-20",
      label: "20°",
      cells: [
        {
          grade: "All grades",
          sends: 4,
          climbs: 8,
          unknownOutcomes: 0,
          successRate: 50,
          sampleStatus: "available",
          differencePercentagePoints: 15,
          examples: [],
        },
      ],
    },
    {
      key: "angle-40",
      label: "40°",
      cells: [
        {
          grade: "All grades",
          sends: 1,
          climbs: 5,
          unknownOutcomes: 0,
          successRate: 20,
          sampleStatus: "available",
          differencePercentagePoints: -15,
          examples: [],
        },
      ],
    },
  ],
  progress: [
    {
      startDate: "2026-08-15",
      endDate: "2026-08-31",
      rows: [
        {
          key: "angle-0",
          cells: [
            {
              grade: "All grades",
              sends: 0,
              climbs: 0,
              unknownOutcomes: 0,
              successRate: null,
              sampleStatus: "no_data",
            },
          ],
        },
        {
          key: "angle-20",
          cells: [
            {
              grade: "All grades",
              sends: 0,
              climbs: 0,
              unknownOutcomes: 0,
              successRate: null,
              sampleStatus: "no_data",
            },
          ],
        },
        {
          key: "angle-40",
          cells: [
            {
              grade: "All grades",
              sends: 0,
              climbs: 0,
              unknownOutcomes: 0,
              successRate: null,
              sampleStatus: "no_data",
            },
          ],
        },
      ],
    },
    {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      rows: [
        {
          key: "angle-0",
          cells: [
            {
              grade: "All grades",
              sends: 0,
              climbs: 3,
              unknownOutcomes: 0,
              successRate: 0,
              sampleStatus: "limited",
            },
          ],
        },
        {
          key: "angle-20",
          cells: [
            {
              grade: "All grades",
              sends: 1,
              climbs: 3,
              unknownOutcomes: 0,
              successRate: 33,
              sampleStatus: "limited",
            },
          ],
        },
        {
          key: "angle-40",
          cells: [
            {
              grade: "All grades",
              sends: 1,
              climbs: 5,
              unknownOutcomes: 0,
              successRate: 20,
              sampleStatus: "available",
            },
          ],
        },
      ],
    },
    {
      startDate: "2026-10-01",
      endDate: "2026-10-26",
      rows: [
        {
          key: "angle-0",
          cells: [
            {
              grade: "All grades",
              sends: 2,
              climbs: 7,
              unknownOutcomes: 0,
              successRate: 29,
              sampleStatus: "available",
            },
          ],
        },
        {
          key: "angle-20",
          cells: [
            {
              grade: "All grades",
              sends: 4,
              climbs: 8,
              unknownOutcomes: 0,
              successRate: 50,
              sampleStatus: "available",
            },
          ],
        },
        {
          key: "angle-40",
          cells: [
            {
              grade: "All grades",
              sends: 1,
              climbs: 5,
              unknownOutcomes: 0,
              successRate: 20,
              sampleStatus: "available",
            },
          ],
        },
      ],
    },
  ],
};
