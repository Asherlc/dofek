const METHOD = "circular_moving_block_bootstrap" as const;
const LEVEL = 0.95 as const;
const REQUESTED_REPLICATE_COUNT = 2_000;
const MAX_ATTEMPT_COUNT = 20_000;

interface BootstrapMetadata {
  method: typeof METHOD;
  level: typeof LEVEL;
  blockLength: number;
  requestedReplicateCount: typeof REQUESTED_REPLICATE_COUNT;
  attemptedReplicateCount: number;
  validReplicateCount: number;
}

export interface AvailableBootstrapInterval extends BootstrapMetadata {
  availability: "available";
  lower: number;
  upper: number;
}

export interface UnavailableBootstrapInterval extends BootstrapMetadata {
  availability: "unavailable";
  reason: "empty_input" | "degenerate_input" | "insufficient_valid_replicates";
}

export type BootstrapInterval = AvailableBootstrapInterval | UnavailableBootstrapInterval;

type BootstrapStatistic<T> = (sample: readonly T[]) => number | null;

/**
 * Percentile interval from circular blocks of consecutive observations.
 *
 * The input array is the time axis. Callers must retain missing observations in
 * that array and let `statistic` filter valid values inside each replicate.
 */
export function circularMovingBlockBootstrapInterval<T>(
  observations: readonly T[],
  statistic: BootstrapStatistic<T>,
): BootstrapInterval {
  const observationCount = observations.length;
  const blockLength = Math.ceil(Math.cbrt(observationCount));
  const metadata: Pick<
    BootstrapMetadata,
    "method" | "level" | "blockLength" | "requestedReplicateCount"
  > = {
    method: METHOD,
    level: LEVEL,
    blockLength,
    requestedReplicateCount: REQUESTED_REPLICATE_COUNT,
  };

  if (observationCount === 0) {
    return {
      ...metadata,
      availability: "unavailable",
      attemptedReplicateCount: 0,
      validReplicateCount: 0,
      reason: "empty_input",
    };
  }

  const originalValue = statistic(observations);
  if (originalValue === null || !Number.isFinite(originalValue)) {
    return {
      ...metadata,
      availability: "unavailable",
      attemptedReplicateCount: 0,
      validReplicateCount: 0,
      reason: "degenerate_input",
    };
  }

  const random = createInputDerivedRandom(observations);
  const values: number[] = [];
  let attemptedReplicateCount = 0;

  while (values.length < REQUESTED_REPLICATE_COUNT && attemptedReplicateCount < MAX_ATTEMPT_COUNT) {
    attemptedReplicateCount++;
    const sample: T[] = [];
    while (sample.length < observationCount) {
      const start = Math.floor(random() * observationCount);
      for (let offset = 0; offset < blockLength && sample.length < observationCount; offset++) {
        const observation = observations[(start + offset) % observationCount];
        if (observation !== undefined) sample.push(observation);
      }
    }

    const value = statistic(sample);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }

  if (values.length < REQUESTED_REPLICATE_COUNT) {
    return {
      ...metadata,
      availability: "unavailable",
      attemptedReplicateCount,
      validReplicateCount: values.length,
      reason: "insufficient_valid_replicates",
    };
  }

  values.sort((a, b) => a - b);
  const tailProbability = (1 - LEVEL) / 2;
  return {
    ...metadata,
    availability: "available",
    attemptedReplicateCount,
    validReplicateCount: values.length,
    lower: percentile(values, tailProbability),
    upper: percentile(values, 1 - tailProbability),
  };
}

function percentile(sortedValues: readonly number[], probability: number): number {
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex] ?? 0;
  const upper = sortedValues[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

function createInputDerivedRandom(input: readonly unknown[]): () => number {
  const serialized = JSON.stringify(input);
  let state = 2_166_136_261;
  for (let index = 0; index < serialized.length; index++) {
    state ^= serialized.charCodeAt(index);
    state = Math.imul(state, 16_777_619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
