import { logger } from "../logger.ts";

export const MAX_FUTURE_SAMPLE_SKEW_MS = 5 * 60 * 1000;

type TimestampedSample = {
  readonly timestamp: string;
};

export function filterFutureSamples<T extends TimestampedSample>(
  samples: readonly T[],
  now: Date,
  source: string,
): T[] {
  const futureLimitMs = now.getTime() + MAX_FUTURE_SAMPLE_SKEW_MS;

  return samples.filter((sample) => {
    const sampleTimeMs = Date.parse(sample.timestamp);

    if (!Number.isFinite(sampleTimeMs)) {
      logger.warn(`${source} sample has invalid timestamp, dropping`, {
        timestamp: sample.timestamp,
      });
      return false;
    }

    if (sampleTimeMs > futureLimitMs) {
      logger.warn(`${source} sample timestamp is too far in the future, dropping`, {
        timestamp: sample.timestamp,
        nowIso: now.toISOString(),
      });
      return false;
    }

    return true;
  });
}
