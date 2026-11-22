import { resampleCyclingStream } from "@dofek/training/cycling-workout-metrics";
import { cyclingPowerCoveragePolicy } from "dofek/analytics/cycling-power-policy";
import { lambertsFitDurationSeconds } from "dofek/fit/lamberts-workout";
import type { CyclingEffortSample } from "./cycling-effort-metrics.ts";

// Original study, Methods and Figure 2, doi:10.1136/bjsm.2009.061325.
const stageWindows = [
  { stage: 1, target: 60, start: 60, end: 360 },
  { stage: 2, target: 80, start: 450, end: 750 },
  { stage: 3, target: 90, start: 810, end: 930 },
] as const;
const recoveryStart = 930;
const recoveryEnd = recoveryStart + 60;
// The authors specify the two 16-second windows in doi:10.1007/s00421-023-05385-z.
const recoveryAverageSeconds = 16;

interface LambertsStageResult {
  stage: 1 | 2 | 3;
  target_maximum_heart_rate_pct: 60 | 80 | 90;
  mean_power_watts: number | null;
  mean_heart_rate_bpm: number | null;
  mean_cadence_rpm: number | null;
  mean_speed_meters_per_second: number | null;
  perceived_exertion: null;
}

interface LambertsTestResults {
  stages: LambertsStageResult[];
  recovery: {
    observed_heart_rate_drop_bpm: number | null;
    non_pedaling: boolean | null;
    seated_upright: null;
  };
}

function meanInWindow(values: (number | null)[], start: number, end: number): number | null {
  const window = values.slice(start, end);
  if (window.length !== end - start || !window.every((value) => value !== null)) return null;
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}

/** Sensor offsets are relative to the start of the first recorded test stage. */
export function calculateLambertsTestResults(samples: CyclingEffortSample[]): LambertsTestResults {
  const power = resampleCyclingStream(
    samples,
    lambertsFitDurationSeconds,
    (sample) => sample.powerWatts,
    cyclingPowerCoveragePolicy,
  ).values;
  const heartRate = resampleCyclingStream(
    samples,
    lambertsFitDurationSeconds,
    (sample) => sample.heartRateBpm,
    cyclingPowerCoveragePolicy,
    1,
  ).values;
  const cadence = resampleCyclingStream(
    samples,
    lambertsFitDurationSeconds,
    (sample) => sample.cadenceRpm,
    cyclingPowerCoveragePolicy,
  ).values;
  const speed = resampleCyclingStream(
    samples,
    lambertsFitDurationSeconds,
    (sample) => sample.speedMetersPerSecond,
    cyclingPowerCoveragePolicy,
  ).values;

  const recoverySamples = samples.filter(
    ({ elapsedSeconds }) => elapsedSeconds >= recoveryStart && elapsedSeconds < recoveryEnd,
  );
  const recoveryCadence = resampleCyclingStream(
    recoverySamples,
    recoveryEnd,
    (sample) => sample.cadenceRpm,
    cyclingPowerCoveragePolicy,
  ).values.slice(recoveryStart);
  const nonPedaling = recoverySamples.some(({ cadenceRpm }) => (cadenceRpm ?? 0) > 0)
    ? false
    : recoveryCadence.every((value) => value === 0)
      ? true
      : null;
  const endOfStage = meanInWindow(heartRate, recoveryStart - recoveryAverageSeconds, recoveryStart);
  const endOfRecovery = meanInWindow(heartRate, recoveryEnd - recoveryAverageSeconds, recoveryEnd);
  return {
    stages: stageWindows.map(({ stage, target, start, end }) => ({
      stage,
      target_maximum_heart_rate_pct: target,
      mean_power_watts: meanInWindow(power, start, end),
      mean_heart_rate_bpm: meanInWindow(heartRate, start, end),
      mean_cadence_rpm: meanInWindow(cadence, start, end),
      mean_speed_meters_per_second: meanInWindow(speed, start, end),
      perceived_exertion: null,
    })),
    recovery: {
      observed_heart_rate_drop_bpm:
        nonPedaling && endOfStage !== null && endOfRecovery !== null
          ? endOfStage - endOfRecovery
          : null,
      non_pedaling: nonPedaling,
      seated_upright: null,
    },
  };
}
