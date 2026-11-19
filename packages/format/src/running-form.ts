import { runningCadenceLabel } from "@dofek/training/running-cadence";
import type { RunningDynamicsRow } from "@dofek/training/running-response";
import { formatNumber } from "./format.ts";

/** The form measurements supplied with a resolved activity detail. */
export type RunningFormMeasurements = Pick<
  RunningDynamicsRow,
  | "cadence"
  | "cadenceBasis"
  | "cadenceObservedSeconds"
  | "cadenceCoveragePercent"
  | "strideLengthMeters"
  | "stanceTimeMs"
  | "verticalOscillationMm"
>;

export interface RunningFormMeasurement {
  label: string;
  value: string;
  qualifier?: string;
}

/** Display-ready form readings; absence stays absent and recorded zeros are kept. */
export function formatRunningFormMeasurements(
  form: RunningFormMeasurements,
): RunningFormMeasurement[] {
  const readings: RunningFormMeasurement[] = [];
  if (form.cadence != null) {
    readings.push({
      label: "Cadence",
      value: `${formatNumber(form.cadence, 0)} spm`,
      qualifier: runningCadenceLabel(form),
    });
  }
  if (form.strideLengthMeters != null) {
    readings.push({
      label: "Stride length",
      value: `${formatNumber(form.strideLengthMeters, 2)} m`,
    });
  }
  if (form.stanceTimeMs != null) {
    readings.push({ label: "Ground contact time", value: `${Math.round(form.stanceTimeMs)} ms` });
  }
  if (form.verticalOscillationMm != null) {
    readings.push({
      label: "Vertical oscillation",
      value: `${formatNumber(form.verticalOscillationMm)} mm`,
    });
  }
  return readings;
}
