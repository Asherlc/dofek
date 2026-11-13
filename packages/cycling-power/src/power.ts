import { resampleSignal, type SignalCoveragePolicy } from "./resample-signal.ts";

export interface PowerSample {
  elapsedSeconds: number;
  watts: number | null;
}

export type PowerCoveragePolicy = SignalCoveragePolicy;

function finiteNonnegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/** Complete 30-second rolling means, fourth-power mean, fourth root. */
export function normalizedPower(
  samples: readonly PowerSample[],
  durationSeconds: number,
  policy: PowerCoveragePolicy,
): number | null {
  for (const sample of samples) {
    if (sample.watts !== null && !finiteNonnegative(sample.watts)) {
      throw new RangeError("Power samples require finite nonnegative watts");
    }
  }
  const { buckets, coverage } = resampleSignal(
    samples.map((sample) => ({ elapsedSeconds: sample.elapsedSeconds, value: sample.watts })),
    durationSeconds,
    policy,
  );
  const duration = durationSeconds;
  if (duration < 30 || coverage.missingSeconds > 0) return null;
  let sum = 0;
  let fourth = 0;
  for (let second = 0; second < duration; second++) {
    sum += buckets.get(second)?.value ?? 0;
    if (second >= 30) sum -= buckets.get(second - 30)?.value ?? 0;
    if (second >= 29) fourth += (sum / 30) ** 4;
  }
  return (fourth / (duration - 29)) ** 0.25;
}

export function intensityFactor(
  normalizedWatts: number | null,
  thresholdWatts: number | null,
): number | null {
  return finiteNonnegative(normalizedWatts) &&
    finiteNonnegative(thresholdWatts) &&
    thresholdWatts > 0
    ? normalizedWatts / thresholdWatts
    : null;
}

/** Threshold-independent power dose; units W²·s. */
export function powerDose(normalizedWatts: number | null, durationSeconds: number): number | null {
  return finiteNonnegative(normalizedWatts) &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0
    ? normalizedWatts ** 2 * durationSeconds
    : null;
}

export function powerTrainingStress(
  normalizedWatts: number | null,
  thresholdWatts: number | null,
  durationSeconds: number,
): number | null {
  const dose = powerDose(normalizedWatts, durationSeconds);
  return dose !== null && finiteNonnegative(thresholdWatts) && thresholdWatts > 0
    ? dose / (36 * thresholdWatts ** 2)
    : null;
}
