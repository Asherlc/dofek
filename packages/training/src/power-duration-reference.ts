export interface PowerDurationSample {
  elapsedSeconds: number;
  watts: number;
}

export interface PowerDurationResult {
  watts: number;
  startOffsetSeconds: number;
  observedSamples: number;
  medianSampleIntervalSeconds: number;
  largestGapSeconds: number;
  coveragePct: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint] ?? Number.NaN;
  return ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2;
}

export function referenceBestPower(
  samples: readonly PowerDurationSample[],
  durationSeconds: number,
): PowerDurationResult | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || samples.length < 2) {
    return null;
  }
  if (
    samples.some(
      ({ elapsedSeconds, watts }) =>
        !Number.isFinite(elapsedSeconds) || !Number.isFinite(watts) || watts < 0,
    )
  ) {
    return null;
  }

  const sorted = [...samples].sort((left, right) => left.elapsedSeconds - right.elapsedSeconds);
  const intervals = sorted.slice(1).map((sample, index) => {
    const previous = sorted[index];
    return previous ? sample.elapsedSeconds - previous.elapsedSeconds : Number.NaN;
  });
  if (intervals.some((interval) => interval <= 0)) return null;

  const medianSampleIntervalSeconds = median(intervals);
  if (durationSeconds < medianSampleIntervalSeconds) return null;

  const cumulativeEnergy = [0];
  for (let index = 0; index < intervals.length; index += 1) {
    cumulativeEnergy.push(
      (cumulativeEnergy[index] ?? 0) + (sorted[index]?.watts ?? 0) * (intervals[index] ?? 0),
    );
  }

  const continuityToleranceSeconds = Math.max(5, medianSampleIntervalSeconds * 2);
  const finalOffset = sorted.at(-1)?.elapsedSeconds ?? 0;
  let best: PowerDurationResult | null = null;

  for (let startIndex = 0; startIndex < sorted.length - 1; startIndex += 1) {
    const startOffsetSeconds = sorted[startIndex]?.elapsedSeconds ?? 0;
    const endOffsetSeconds = startOffsetSeconds + durationSeconds;
    if (endOffsetSeconds > finalOffset) continue;

    let endSegmentIndex = startIndex;
    while (
      endSegmentIndex < intervals.length &&
      (sorted[endSegmentIndex + 1]?.elapsedSeconds ?? Number.POSITIVE_INFINITY) < endOffsetSeconds
    ) {
      endSegmentIndex += 1;
    }

    const endSegment = sorted[endSegmentIndex];
    if (!endSegment) continue;
    const usedIntervals = intervals.slice(startIndex, endSegmentIndex + 1);
    const largestGapSeconds = Math.max(...usedIntervals);
    if (largestGapSeconds > continuityToleranceSeconds) continue;

    const endEnergy =
      (cumulativeEnergy[endSegmentIndex] ?? 0) +
      endSegment.watts * (endOffsetSeconds - endSegment.elapsedSeconds);
    const startEnergy = cumulativeEnergy[startIndex] ?? 0;
    const watts = (endEnergy - startEnergy) / durationSeconds;
    const observedSamples = sorted.filter(
      (sample) =>
        sample.elapsedSeconds >= startOffsetSeconds && sample.elapsedSeconds <= endOffsetSeconds,
    ).length;
    const candidate = {
      coveragePct: 100,
      largestGapSeconds,
      medianSampleIntervalSeconds,
      observedSamples,
      startOffsetSeconds,
      watts,
    };

    if (
      best === null ||
      candidate.watts > best.watts ||
      (candidate.watts === best.watts && candidate.startOffsetSeconds < best.startOffsetSeconds)
    ) {
      best = candidate;
    }
  }

  return best;
}
