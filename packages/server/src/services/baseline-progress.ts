import type { DerivedProcessingStatus } from "dofek/processing/processing-state";
import type {
  BaselineProgress,
  BaselineProgressBlocker,
} from "../contracts/mobile-dashboard-contracts.ts";

export const BASELINE_REQUIRED_OBSERVATION_DAYS = 3;

export type BaselineProcessingStatus = "syncing" | "sync_error" | null;

interface BaselineProgressInput {
  label: string;
  value: number | null;
  observedDays: number;
  sampleDeviation: number | null;
  processingStatus: BaselineProcessingStatus;
}

interface ProcessingStatusSnapshotLike {
  overallStatus: DerivedProcessingStatus;
  datasets: readonly { key: string; status: DerivedProcessingStatus }[];
}

function hasMeasurableVariation(sampleDeviation: number | null): boolean {
  return sampleDeviation != null && Number.isFinite(sampleDeviation) && sampleDeviation > 0;
}

function remainingObservationText(days: number): string {
  return `${days} more ${days === 1 ? "day" : "days"}`;
}

function progressSummary(label: string, observedDays: number): string {
  return `${label} has ${observedDays} of ${BASELINE_REQUIRED_OBSERVATION_DAYS} required days recorded; the baseline is still collecting observations.`;
}

function progressAction(label: string, observedDays: number): string {
  const remainingDays = Math.max(0, BASELINE_REQUIRED_OBSERVATION_DAYS - observedDays);
  return `Keep syncing ${label.toLowerCase()} data for at least ${remainingObservationText(remainingDays)}.`;
}

function missingSourceSummary(label: string): string {
  return `No ${label} data is available in this baseline window.`;
}

function missingSourceAction(label: string): string {
  return `Connect or sync a source that records ${label.toLowerCase()}.`;
}

export function buildBaselineProgress(input: BaselineProgressInput): BaselineProgress {
  const observedDays = Math.max(0, Math.trunc(input.observedDays));
  const variation = observedDays > 1 && hasMeasurableVariation(input.sampleDeviation);
  let blocker: BaselineProgressBlocker | null = null;
  let summary = `${input.label} baseline is ready.`;
  let action = "No action needed.";

  if (input.processingStatus === "syncing") {
    blocker = "syncing";
    summary = `${input.label} baseline data is still syncing.`;
    action = "Wait for the sync to finish, then check your baseline again.";
  } else if (input.processingStatus === "sync_error") {
    blocker = "sync_error";
    summary = `${input.label} baseline data could not sync.`;
    action = "Reconnect the data source and start the sync again.";
  } else if (observedDays === 0 || input.value == null) {
    blocker = "missing_source_data";
    summary = missingSourceSummary(input.label);
    action = missingSourceAction(input.label);
  } else if (observedDays < BASELINE_REQUIRED_OBSERVATION_DAYS) {
    blocker = "collecting";
    summary = progressSummary(input.label, observedDays);
    action = progressAction(input.label, observedDays);
  } else if (!variation) {
    blocker = "needs_variation";
    summary = `${input.label} has enough observations, but they have not varied yet.`;
    action = `Continue recording ${input.label.toLowerCase()} data until the values vary.`;
  }

  return {
    requiredObservationDays: BASELINE_REQUIRED_OBSERVATION_DAYS,
    observedObservationDays: observedDays,
    hasMeasurableVariation: variation,
    blocker,
    requirement: `A current value plus at least ${BASELINE_REQUIRED_OBSERVATION_DAYS - 1} more recorded days with measurable variation.`,
    summary,
    action,
  };
}

export function baselineProcessingStatus(
  snapshot: ProcessingStatusSnapshotLike,
  datasetKey: string,
): BaselineProcessingStatus {
  const status =
    snapshot.datasets.find((dataset) => dataset.key === datasetKey)?.status ??
    snapshot.overallStatus;
  if (["waiting", "active", "partial", "delayed"].includes(status)) return "syncing";
  if (["blocked", "failed"].includes(status)) return "sync_error";
  return null;
}
