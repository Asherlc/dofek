import {
  intensityFactor,
  normalizedPower,
  type PowerSample,
  powerTrainingStress,
} from "@dofek/cycling-power/power";
import { cyclingPowerCoveragePolicy } from "dofek/analytics/cycling-power-policy";

export interface CyclingPowerWindow {
  samples: readonly PowerSample[];
  durationSeconds: number;
  thresholdWatts: number | null;
}

/** App adapter only; all numerical work is owned by the reusable package. */
export async function evaluateCyclingPowerWindows(windows: readonly CyclingPowerWindow[]) {
  return windows.map((window) => {
    const normalizedPowerWatts = normalizedPower(
      window.samples,
      window.durationSeconds,
      cyclingPowerCoveragePolicy,
    );
    return {
      normalizedPowerWatts,
      intensityFactor: intensityFactor(normalizedPowerWatts, window.thresholdWatts),
      trainingStressScore: powerTrainingStress(
        normalizedPowerWatts,
        window.thresholdWatts,
        window.durationSeconds,
      ),
    };
  });
}
