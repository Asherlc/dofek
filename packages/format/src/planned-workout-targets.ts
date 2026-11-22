/**
 * Structural shape of an authored planned-workout target as projected by the
 * calendar router. Declared locally so shared packages need no server import.
 */
export interface PlannedWorkoutTargetInput {
  type: "power" | "heart_rate" | "pace" | "cadence";
  value: number | null;
  start: number | null;
  end: number | null;
  unit: string | null;
}

const TARGET_LABELS: Record<PlannedWorkoutTargetInput["type"], string> = {
  power: "Power",
  heart_rate: "Heart rate",
  pace: "Pace",
  cadence: "Cadence",
};

function withUnit(value: number, unit: string | null): string {
  if (!unit) return String(value);
  return unit === "%" ? `${value}%` : `${value} ${unit}`;
}

/** Exact authored target text, preserving the label and the unit on the upper bound of a range. */
export function formatPlannedWorkoutTarget(target: PlannedWorkoutTargetInput): string {
  const label = TARGET_LABELS[target.type] ?? target.type;
  if (target.value != null) return `${label} ${withUnit(target.value, target.unit)}`;
  if (target.start != null && target.end != null) {
    return `${label} ${withUnit(target.start, null)}–${withUnit(target.end, target.unit)}`;
  }
  if (target.start != null) return `${label} at least ${withUnit(target.start, target.unit)}`;
  if (target.end != null) return `${label} up to ${withUnit(target.end, target.unit)}`;
  return label;
}

/** Structural shape of an authored step; mirrors the neutral router projection without a server import. */
export type PlannedWorkoutStepInput =
  | {
      kind: "step";
      text: string | null;
      durationSeconds: number | null;
      distanceMeters: number | null;
      targets: readonly PlannedWorkoutTargetInput[];
    }
  | {
      kind: "repeat";
      repetitions: number;
      text: string | null;
      steps: readonly PlannedWorkoutStepInput[];
    }
  | { kind: "unsupported" };

function serializeStep(step: PlannedWorkoutStepInput): string {
  switch (step.kind) {
    case "step":
      return JSON.stringify([
        "s",
        step.text,
        step.durationSeconds,
        step.distanceMeters,
        step.targets.map((target) => [
          target.type,
          target.value,
          target.start,
          target.end,
          target.unit,
        ]),
      ]);
    case "repeat":
      return JSON.stringify(["r", step.repetitions, step.text, step.steps.map(serializeStep)]);
    case "unsupported":
      return "u";
  }
}

/**
 * Content-addressed React keys for an authored step list. Identical sibling
 * steps get an occurrence suffix so deliberate repeats stay distinct without
 * using the array index as the key.
 */
export function withPlannedWorkoutStepKeys<S extends PlannedWorkoutStepInput>(
  steps: readonly S[],
): Array<readonly [S, string]> {
  const occurrences = new Map<string, number>();
  return steps.map((step) => {
    const serialized = serializeStep(step);
    const occurrence = (occurrences.get(serialized) ?? 0) + 1;
    occurrences.set(serialized, occurrence);
    return [step, `${serialized}#${occurrence}`] as const;
  });
}
