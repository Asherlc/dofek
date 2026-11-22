import { average, round } from "./cycling-sample-math.ts";

interface IntervalOffsets {
  startOffsetSeconds: number;
  endOffsetSeconds: number;
}

/**
 * Indexes of the 1 Hz timestamps `t` with `start <= t < end`: `ceil` of each exact bound, clamped
 * into the stream. A window with no timestamp is empty; it is never sliced from the end.
 */
export function selectIntervalSamples(length: number, interval: IntervalOffsets) {
  const startOffsetSeconds = Math.min(length, Math.max(0, Math.ceil(interval.startOffsetSeconds)));
  const endOffsetSeconds = Math.max(
    startOffsetSeconds,
    Math.min(length, Math.ceil(interval.endOffsetSeconds)),
  );
  return { startOffsetSeconds, endOffsetSeconds };
}

/**
 * Gap-aware mean over the selected 1 Hz timestamps of a resampled power stream. Missing seconds
 * are skipped, a measured zero stays zero, and no measured sample is null.
 */
export function summarizeIntervalPower(
  powerValues: ReadonlyArray<number | null>,
  interval: IntervalOffsets,
) {
  const selected = selectIntervalSamples(powerValues.length, interval);
  const mean = average(powerValues.slice(selected.startOffsetSeconds, selected.endOffsetSeconds));
  return {
    ...selected,
    meanPowerWatts: mean,
    averagePowerWatts: mean == null ? null : round(mean),
  };
}
