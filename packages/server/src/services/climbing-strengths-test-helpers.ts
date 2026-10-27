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
