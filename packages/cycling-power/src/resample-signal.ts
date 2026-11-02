export interface SignalSample {
  elapsedSeconds: number;
  value: number | null;
}

export interface SignalCoveragePolicy {
  maximumHoldSeconds: number;
  minimumGapSeconds: number;
  gapIntervalMultiplier: number;
  maximumGapSeconds: number;
}

export interface SignalBucket {
  value: number;
  maximumValue: number;
  coveredDuration: number;
}

/** Sparse complete one-second buckets. Null observations end coverage until the next value.
 * Durations must be nonnegative integer seconds; offsets may be fractional.
 * Duplicate nulls dominate values; conflicting finite values are rejected.
 */
export function resampleSignal(
  samples: readonly SignalSample[],
  durationSeconds: number,
  policy: SignalCoveragePolicy,
) {
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0) {
    throw new RangeError("Signal duration must be a nonnegative safe integer number of seconds");
  }
  if (
    Object.values(policy).some((value) => !Number.isFinite(value) || value <= 0) ||
    policy.minimumGapSeconds > policy.maximumGapSeconds
  )
    throw new RangeError("Invalid signal coverage policy");

  const grouped = new Map<number, { barrier: boolean; values: Set<number> }>();
  for (const sample of samples) {
    if (
      !Number.isFinite(sample.elapsedSeconds) ||
      sample.elapsedSeconds < 0 ||
      (sample.value !== null && !Number.isFinite(sample.value))
    ) {
      throw new RangeError("Signal offsets and values must be finite, with nonnegative offsets");
    }
    if (sample.elapsedSeconds >= durationSeconds) continue;
    const point = grouped.get(sample.elapsedSeconds) ?? {
      barrier: false,
      values: new Set<number>(),
    };
    if (sample.value === null) point.barrier = true;
    else point.values.add(sample.value);
    grouped.set(sample.elapsedSeconds, point);
  }
  const points = [...grouped]
    .sort(([a], [b]) => a - b)
    .map(([elapsedSeconds, point]) => {
      if (point.values.size > 1)
        throw new RangeError("Conflicting signal values at the same offset");
      return {
        elapsedSeconds,
        value: point.barrier ? null : (point.values.values().next().value ?? null),
      };
    });
  const gaps = points
    .slice(1)
    .map((point, index) => point.elapsedSeconds - (points[index]?.elapsedSeconds ?? 0));
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const middle = Math.floor(sortedGaps.length / 2);
  const upper = sortedGaps[middle];
  const lower = sortedGaps[middle - 1];
  const medianInterval =
    upper === undefined
      ? null
      : sortedGaps.length % 2 === 0
        ? ((lower ?? upper) + upper) / 2
        : upper;
  const nativeInterval = Math.min(policy.maximumHoldSeconds, medianInterval ?? 1);
  const tolerance = Math.min(
    policy.maximumGapSeconds,
    Math.max(policy.minimumGapSeconds, nativeInterval * policy.gapIntervalMultiplier),
  );
  const buckets = new Map<number, SignalBucket>();
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!point || point.value === null) continue;
    const next = points[index + 1];
    const end = Math.min(
      durationSeconds,
      next?.elapsedSeconds ?? durationSeconds,
      point.elapsedSeconds + policy.maximumHoldSeconds,
      next && next.elapsedSeconds - point.elapsedSeconds <= tolerance
        ? next.elapsedSeconds
        : point.elapsedSeconds + nativeInterval,
    );
    for (let second = Math.floor(point.elapsedSeconds); second < end; second++) {
      const covered = Math.min(second + 1, end) - Math.max(second, point.elapsedSeconds);
      const bucket = buckets.get(second) ?? {
        value: 0,
        maximumValue: point.value,
        coveredDuration: 0,
      };
      bucket.value += point.value * covered;
      bucket.maximumValue = Math.max(bucket.maximumValue, point.value);
      bucket.coveredDuration += covered;
      buckets.set(second, bucket);
    }
  }
  let maximumValue: number | null = null;
  let zeroSeconds = 0;
  for (const [second, bucket] of buckets) {
    if (bucket.coveredDuration < 1 - 1e-9) {
      buckets.delete(second);
      continue;
    }
    if (bucket.value === 0) zeroSeconds++;
    maximumValue = Math.max(maximumValue ?? bucket.maximumValue, bucket.maximumValue);
  }
  return {
    buckets,
    maximumValue,
    coverage: {
      observedSamples: points.filter((point) => point.value !== null).length,
      coveredSeconds: buckets.size,
      missingSeconds: durationSeconds - buckets.size,
      zeroSeconds,
      coveragePct: durationSeconds > 0 ? (buckets.size / durationSeconds) * 100 : 0,
      medianSampleIntervalSeconds: medianInterval,
      largestGapSeconds: gaps.reduce<number | null>(
        (largest, gap) => Math.max(largest ?? gap, gap),
        null,
      ),
    },
  };
}
