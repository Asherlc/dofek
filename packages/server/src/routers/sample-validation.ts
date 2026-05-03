import { TRPCError } from "@trpc/server";

export const MAX_FUTURE_SAMPLE_SKEW_MS = 5 * 60 * 1000;

type TimestampedSample = {
  readonly timestamp: string;
};

export function rejectFutureSamples(
  samples: readonly TimestampedSample[],
  now: Date,
  source: string,
) {
  const futureLimitMs = now.getTime() + MAX_FUTURE_SAMPLE_SKEW_MS;

  const invalidSample = samples.find((sample) => {
    const sampleTimeMs = Date.parse(sample.timestamp);
    if (!Number.isFinite(sampleTimeMs)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${source} sample timestamp is invalid: ${sample.timestamp}`,
      });
    }

    return sampleTimeMs > futureLimitMs;
  });

  if (!invalidSample) {
    return;
  }

  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `${source} sample timestamp is too far in the future: ${invalidSample.timestamp}`,
  });
}
