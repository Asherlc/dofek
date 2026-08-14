/** Primary outcome goals selected during onboarding and editable in settings. */

export const PRIMARY_GOAL_SETTINGS_KEY = "primaryGoal";

export const primaryGoalIds = [
  "racePreparation",
  "sleepConsistency",
  "strengthProgression",
  "weightTrend",
] as const;

export type PrimaryGoal = (typeof primaryGoalIds)[number];

export interface PrimaryGoalOption {
  id: PrimaryGoal;
  label: string;
  description: string;
}

export const PRIMARY_GOAL_OPTIONS: ReadonlyArray<PrimaryGoalOption> = [
  {
    id: "racePreparation",
    label: "Race preparation",
    description: "Train toward a race or event date",
  },
  {
    id: "sleepConsistency",
    label: "Sleep consistency",
    description: "Build steadier sleep timing and quality",
  },
  {
    id: "strengthProgression",
    label: "Strength progression",
    description: "Increase strength over time",
  },
  {
    id: "weightTrend",
    label: "Weight trend",
    description: "Track body weight toward a target",
  },
];

const GOAL_IDS: ReadonlySet<string> = new Set(primaryGoalIds);
const GOAL_MAP: ReadonlyMap<string, PrimaryGoalOption> = new Map(
  PRIMARY_GOAL_OPTIONS.map((option) => [option.id, option]),
);

function isPrimaryGoal(value: unknown): value is PrimaryGoal {
  return typeof value === "string" && GOAL_IDS.has(value);
}

/** Parse a setting value into a PrimaryGoal, or null when unset/invalid. */
export function parsePrimaryGoal(value: unknown): PrimaryGoal | null {
  return isPrimaryGoal(value) ? value : null;
}

/** Human-readable label for a primary goal, falls back to the raw id. */
export function primaryGoalLabel(id: string): string {
  return GOAL_MAP.get(id)?.label ?? id;
}
