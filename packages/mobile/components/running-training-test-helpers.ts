import type { RunningDynamicsRow, TrainingChartAvailability } from "dofek-server/types";
export const availableRunning: TrainingChartAvailability = {
  status: "available",
  sourceLabel: "Running activity sensor summaries",
  observedCount: 2,
  minimumCount: 1,
  message: "Running form is available.",
};
export const emptyRunning: TrainingChartAvailability = {
  ...availableRunning,
  status: "insufficient_data",
  observedCount: 0,
  message:
    "No cadence samples or usable imported step intervals are available for these runs. Check the selected range and Apple Health sync status.",
};
export const recordedRun: RunningDynamicsRow = {
  activityId: "run-1",
  date: "2026-10-01",
  activityName: "Morning Run",
  cadence: 172,
  cadenceBasis: "cadence_samples",
  cadenceObservedSeconds: null,
  cadenceCoveragePercent: null,
  strideLengthMeters: 1.2,
  stanceTimeMs: 240,
  verticalOscillationMm: 82,
  paceSecondsPerKm: 300,
  distanceKm: 8.5,
};
export const intervalRun: RunningDynamicsRow = {
  ...recordedRun,
  activityId: "run-2",
  date: "2026-10-04",
  activityName: "Park Run",
  cadence: 200,
  cadenceBasis: "step_intervals",
  cadenceObservedSeconds: 180,
  cadenceCoveragePercent: 30,
  strideLengthMeters: null,
  verticalOscillationMm: null,
};
export const runningData = {
  data: [recordedRun, intervalRun],
  availability: availableRunning,
  cadenceAvailability: availableRunning,
};

export const emptyRunningForm: TrainingChartAvailability = {
  ...emptyRunning,
  message:
    "No running form measurements are available for these runs. Check the selected range and sync status.",
};
