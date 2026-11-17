import { buildClimbingStrengths, type ClimbingStrengthsObservation } from "./climbing-strengths.ts";

export const observation = (
  patch: Partial<ClimbingStrengthsObservation> = {},
): ClimbingStrengthsObservation => ({
  identity: "climb",
  contextKey: "boulder",
  laneKey: "boulder",
  gradeSystem: "v_scale",
  contextLabel: "Bouldering · V scale",
  setting: "indoor",
  grade: "V4",
  gradeSortValue: 4,
  wallAngle: null,
  holdTypes: null,
  outcome: "not_sent",
  example: {
    logEntryId: "log",
    activityId: null,
    name: "Problem",
    grade: "V4",
    date: "2026-10-20",
    providerId: "kaya",
    sourceName: "KAYA",
    sourceUrl: null,
    outcome: "not_sent",
  },
  ...patch,
});
const window = { startDate: "2026-08-15", endDate: "2026-10-20" };
export const analyze = (observations: ClimbingStrengthsObservation[]) =>
  buildClimbingStrengths(observations, window);
export const dated = (date: string, patch: Partial<ClimbingStrengthsObservation> = {}) => {
  const entry = observation(patch);
  return { ...entry, example: { ...entry.example, date } };
};

export const mixedSettingObservations = () =>
  (["indoor", "outdoor"] as const).map((setting) =>
    observation({
      identity: setting,
      setting,
      outcome: setting === "indoor" ? "sent" : "not_sent",
      wallAngle: { category: "slab" },
      holdTypes: ["crimp"],
    }),
  );

/** Literal expectations for the server's monthly cell contract. */
export const progressCell = (
  grade: string,
  sends: number,
  climbs: number,
  unknownOutcomes: number,
  successRate: number | null,
  sampleStatus: "no_data" | "limited" | "available",
) => ({ grade, sends, climbs, unknownOutcomes, successRate, sampleStatus });

export const resolvedGradeMonthlyProgress = [
  {
    startDate: "2026-08-15",
    endDate: "2026-08-31",
    rows: [
      {
        key: "crimp",
        cells: [progressCell("V4", 0, 1, 0, 0, "limited")],
      },
    ],
  },
  {
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    rows: [
      {
        key: "crimp",
        cells: [progressCell("V4", 1, 1, 0, 100, "limited")],
      },
    ],
  },
  {
    startDate: "2026-10-01",
    endDate: "2026-10-20",
    rows: [
      {
        key: "crimp",
        cells: [progressCell("V4", 0, 1, 1, null, "limited")],
      },
    ],
  },
];

export const emptyClippedMonth = {
  startDate: "2026-08-15",
  endDate: "2026-08-31",
  rows: [
    {
      key: "indoor",
      cells: [
        progressCell("V3", 0, 0, 0, null, "no_data"),
        progressCell("V4", 0, 0, 0, null, "no_data"),
      ],
    },
    {
      key: "outdoor",
      cells: [
        progressCell("V3", 0, 0, 0, null, "no_data"),
        progressCell("V4", 0, 0, 0, null, "no_data"),
      ],
    },
  ],
};

export const mixedGradeMonthlyObservations = (): ClimbingStrengthsObservation[] => [
  dated("2026-08-16", {
    identity: "sloper-high",
    holdTypes: ["sloper"],
    grade: "V10",
    gradeSortValue: 10,
    outcome: null,
  }),
  dated("2026-08-17", {
    identity: "crimp-high",
    holdTypes: ["crimp"],
    grade: "V10",
    gradeSortValue: 10,
    outcome: "sent",
  }),
  dated("2026-08-18", { identity: "sloper-low", holdTypes: ["sloper"] }),
  dated("2026-09-01", { identity: "sloper-low", holdTypes: ["sloper"], outcome: "sent" }),
  dated("2026-09-30", {
    identity: "sloper-high",
    holdTypes: ["sloper"],
    grade: "V10",
    gradeSortValue: 10,
    outcome: "sent",
  }),
  ...Array.from({ length: 5 }, (_, index) =>
    dated("2026-08-19", {
      identity: `crimp-low-${index}`,
      holdTypes: ["crimp"],
      outcome: index < 2 ? "sent" : "not_sent",
    }),
  ),
  dated("2026-08-20", { identity: "crimp-low-0", holdTypes: ["crimp"], outcome: null }),
  dated("2026-08-21", { identity: "crimp-low-0", holdTypes: ["crimp"] }),
  dated("2026-10-20", { identity: "crimp-low-0", holdTypes: ["crimp"], outcome: null }),
  dated("2026-08-20", {
    identity: "outdoor",
    holdTypes: ["crimp"],
    setting: "outdoor",
    outcome: "sent",
  }),
  dated("2026-08-20", {
    identity: "missing-trait",
    grade: "V8",
    gradeSortValue: 8,
    outcome: "sent",
  }),
];

export const mixedGradeMonthlyProgress = [
  {
    startDate: "2026-08-15",
    endDate: "2026-08-31",
    rows: [
      {
        key: "crimp",
        cells: [
          progressCell("V4", 3, 6, 0, 50, "available"),
          progressCell("V8", 0, 0, 0, null, "no_data"),
          progressCell("V10", 1, 1, 0, 100, "limited"),
        ],
      },
      {
        key: "sloper",
        cells: [
          progressCell("V4", 0, 1, 0, 0, "limited"),
          progressCell("V8", 0, 0, 0, null, "no_data"),
          progressCell("V10", 0, 1, 1, null, "limited"),
        ],
      },
    ],
  },
  {
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    rows: [
      {
        key: "crimp",
        cells: [
          progressCell("V4", 0, 0, 0, null, "no_data"),
          progressCell("V8", 0, 0, 0, null, "no_data"),
          progressCell("V10", 0, 0, 0, null, "no_data"),
        ],
      },
      {
        key: "sloper",
        cells: [
          progressCell("V4", 1, 1, 0, 100, "limited"),
          progressCell("V8", 0, 0, 0, null, "no_data"),
          progressCell("V10", 1, 1, 0, 100, "limited"),
        ],
      },
    ],
  },
  {
    startDate: "2026-10-01",
    endDate: "2026-10-20",
    rows: [
      {
        key: "crimp",
        cells: [
          progressCell("V4", 0, 1, 1, null, "limited"),
          progressCell("V8", 0, 0, 0, null, "no_data"),
          progressCell("V10", 0, 0, 0, null, "no_data"),
        ],
      },
      {
        key: "sloper",
        cells: [
          progressCell("V4", 0, 0, 0, null, "no_data"),
          progressCell("V8", 0, 0, 0, null, "no_data"),
          progressCell("V10", 0, 0, 0, null, "no_data"),
        ],
      },
    ],
  },
];
