import type { AppRouterOutputs } from "dofek-server/router";

export type StrengthProgressionRow = AppRouterOutputs["trainingProgression"]["strength"][number];
type StrengthRow = StrengthProgressionRow;

/** Home shows one status: the first server-ordered row that actually has one. */
export function firstStatusRow(rows: StrengthRow[] | undefined): StrengthRow | undefined {
  return rows?.find((row) => row.status !== null);
}

export function strengthHeadline(row: StrengthRow): string {
  return row.equipment ? `${row.exerciseName} · ${row.equipment}` : row.exerciseName;
}

/** Explain the recorded evidence without assigning a readiness status. */
export function strengthEvidenceSummary(row: StrengthRow): string {
  if (row.evidence.kind === "flat_benchmark") {
    return `Estimated strength held steady across ${row.evidence.observedDates} comparable sessions.`;
  }
  return "More reps at the same weight";
}
