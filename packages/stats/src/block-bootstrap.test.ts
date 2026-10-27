import { describe, expect, it } from "vitest";
import { circularMovingBlockBootstrapInterval } from "./block-bootstrap.ts";

interface Observation {
  date: string;
  x: number | null;
  y: number | null;
}

function observations(values: Array<{ x: number | null; y: number | null }>): Observation[] {
  return values.map((value, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, "0")}`,
    ...value,
  }));
}

function pairedCorrelation(sample: readonly Observation[]): number | null {
  const pairs = sample.filter(
    (observation): observation is Observation & { x: number; y: number } =>
      observation.x !== null && observation.y !== null,
  );
  if (pairs.length < 5) return null;

  const xMean = pairs.reduce((sum, pair) => sum + pair.x, 0) / pairs.length;
  const yMean = pairs.reduce((sum, pair) => sum + pair.y, 0) / pairs.length;
  const numerator = pairs.reduce((sum, pair) => sum + (pair.x - xMean) * (pair.y - yMean), 0);
  const xSquares = pairs.reduce((sum, pair) => sum + (pair.x - xMean) ** 2, 0);
  const ySquares = pairs.reduce((sum, pair) => sum + (pair.y - yMean) ** 2, 0);
  const denominator = Math.sqrt(xSquares * ySquares);
  return denominator === 0 ? null : numerator / denominator;
}

describe("circularMovingBlockBootstrapInterval", () => {
  it("returns empty-input metadata without invoking the statistic", () => {
    let invocationCount = 0;
    const result = circularMovingBlockBootstrapInterval([], () => {
      invocationCount++;
      return 1;
    });

    expect(invocationCount).toBe(0);
    expect(result).toEqual({
      availability: "unavailable",
      method: "circular_moving_block_bootstrap",
      level: 0.95,
      blockLength: 0,
      requestedReplicateCount: 2_000,
      attemptedReplicateCount: 0,
      validReplicateCount: 0,
      reason: "empty_input",
    });
  });

  it("returns the fixed interval metadata for a perfectly positive relationship", () => {
    const input = observations(
      Array.from({ length: 16 }, (_, index) => ({ x: index + 1, y: (index + 1) * 3 })),
    );

    const result = circularMovingBlockBootstrapInterval(input, pairedCorrelation);

    expect(result).toEqual({
      availability: "available",
      method: "circular_moving_block_bootstrap",
      level: 0.95,
      blockLength: 3,
      requestedReplicateCount: 2_000,
      attemptedReplicateCount: 2_000,
      validReplicateCount: 2_000,
      lower: 1,
      upper: 1,
    });
  });

  it("preserves a perfectly negative paired effect", () => {
    const input = observations(
      Array.from({ length: 27 }, (_, index) => ({ x: index + 1, y: 100 - index })),
    );

    const result = circularMovingBlockBootstrapInterval(input, pairedCorrelation);

    expect(result.availability).toBe("available");
    if (result.availability === "available") {
      expect(result.blockLength).toBe(3);
      expect(result.lower).toBeCloseTo(-1, 12);
      expect(result.upper).toBeCloseTo(-1, 12);
    }
  });

  it("is repeatable because its seed is derived from the complete input", () => {
    const input = observations(
      Array.from({ length: 20 }, (_, index) => ({
        x: index % 4 === 0 ? null : index + 1,
        y: index % 5 === 0 ? null : (index * 7) % 13,
      })),
    );

    expect(circularMovingBlockBootstrapInterval(input, pairedCorrelation)).toEqual(
      circularMovingBlockBootstrapInterval(input, pairedCorrelation),
    );
  });

  it("uses deterministic circular blocks and interpolated percentile bounds", () => {
    const input = Array.from({ length: 8 }, (_, index) => ({
      index: index + 1,
      label: `day-${index + 1}`,
    }));
    const orderSensitiveStatistic = (sample: readonly (typeof input)[number][]) =>
      sample.reduce((sum, observation, index) => sum + observation.index * 11 ** index, 0);

    expect(circularMovingBlockBootstrapInterval(input, orderSensitiveStatistic)).toEqual({
      availability: "available",
      method: "circular_moving_block_bootstrap",
      level: 0.95,
      blockLength: 2,
      requestedReplicateCount: 2_000,
      attemptedReplicateCount: 2_000,
      validReplicateCount: 2_000,
      lower: 34_005_051.7,
      upper: 169_516_410.8,
    });
  });

  it("keeps missing markers in the resampling input", () => {
    const input = observations(
      Array.from({ length: 27 }, (_, index) => ({
        x: index === 8 || index === 9 ? null : index + 1,
        y: index === 17 ? null : (index * 5) % 19,
      })),
    );

    const result = circularMovingBlockBootstrapInterval(input, pairedCorrelation);

    expect(result.blockLength).toBe(3);
    expect(result.requestedReplicateCount).toBe(2_000);
    expect(result.attemptedReplicateCount).toBeGreaterThanOrEqual(2_000);
    expect(result.validReplicateCount).toBeGreaterThan(0);
  });

  it("reports uncertainty as unavailable when fewer than five valid pairs exist", () => {
    const result = circularMovingBlockBootstrapInterval(
      observations([
        { x: 1, y: 1 },
        { x: null, y: 2 },
        { x: 3, y: null },
        { x: 4, y: 4 },
      ]),
      pairedCorrelation,
    );

    expect(result).toEqual({
      availability: "unavailable",
      method: "circular_moving_block_bootstrap",
      level: 0.95,
      blockLength: 2,
      requestedReplicateCount: 2_000,
      attemptedReplicateCount: 0,
      validReplicateCount: 0,
      reason: "degenerate_input",
    });
  });

  it("reports uncertainty as unavailable for a constant metric", () => {
    const result = circularMovingBlockBootstrapInterval(
      observations(
        Array.from({ length: 16 }, (_, index) => ({
          x: 10,
          y: index + 1,
        })),
      ),
      pairedCorrelation,
    );

    expect(result).toEqual({
      availability: "unavailable",
      method: "circular_moving_block_bootstrap",
      level: 0.95,
      blockLength: 3,
      requestedReplicateCount: 2_000,
      attemptedReplicateCount: 0,
      validReplicateCount: 0,
      reason: "degenerate_input",
    });
  });

  it("rejects a non-finite original statistic before resampling", () => {
    let invocationCount = 0;
    const result = circularMovingBlockBootstrapInterval([1, 2, 3, 4, 5], () => {
      invocationCount++;
      return Number.NaN;
    });

    expect(invocationCount).toBe(1);
    expect(result).toEqual({
      availability: "unavailable",
      method: "circular_moving_block_bootstrap",
      level: 0.95,
      blockLength: 2,
      requestedReplicateCount: 2_000,
      attemptedReplicateCount: 0,
      validReplicateCount: 0,
      reason: "degenerate_input",
    });
  });

  it("rejects a null original statistic before resampling", () => {
    let invocationCount = 0;
    const result = circularMovingBlockBootstrapInterval([1, 2, 3, 4, 5], () => {
      invocationCount++;
      return null;
    });

    expect(invocationCount).toBe(1);
    expect(result).toMatchObject({
      availability: "unavailable",
      attemptedReplicateCount: 0,
      validReplicateCount: 0,
      reason: "degenerate_input",
    });
  });

  it("does not pass sparse-array holes to the replicate statistic", () => {
    const sparseInput = Array.from({ length: 8 }, (_, index) => ({ index: index + 1 }));
    delete sparseInput[3];
    const rejectExplicitUndefined = (
      sample: readonly (typeof sparseInput)[number][],
    ): number | null =>
      sample !== sparseInput && sample.some((observation) => observation === undefined) ? null : 1;

    const result = circularMovingBlockBootstrapInterval(sparseInput, rejectExplicitUndefined);

    expect(result).toMatchObject({
      availability: "available",
      attemptedReplicateCount: 2_000,
      validReplicateCount: 2_000,
    });
  });

  it("rejects non-finite replicate statistics", () => {
    const input = [1, 2, 3, 4, 5];
    const finiteOnlyForOriginalInput = (sample: readonly number[]) =>
      sample === input ? 1 : Number.NaN;

    const result = circularMovingBlockBootstrapInterval(input, finiteOnlyForOriginalInput);

    expect(result).toMatchObject({
      availability: "unavailable",
      attemptedReplicateCount: 20_000,
      validReplicateCount: 0,
      reason: "insufficient_valid_replicates",
    });
  });

  it("does not publish an interval when the attempt cap cannot yield 2,000 valid replicates", () => {
    const input = observations(
      Array.from({ length: 16 }, (_, index) => ({
        x: index + 1,
        y: (index + 1) * 2,
      })),
    );
    const onlyOriginalOrderIsValid = (sample: readonly Observation[]): number | null =>
      sample.every((observation, index) => observation.date === input[index]?.date) ? 1 : null;

    const result = circularMovingBlockBootstrapInterval(input, onlyOriginalOrderIsValid);

    expect(result.availability).toBe("unavailable");
    if (result.availability === "unavailable") {
      expect(result.reason).toBe("insufficient_valid_replicates");
      expect(result.attemptedReplicateCount).toBe(20_000);
      expect(result.validReplicateCount).toBeLessThan(2_000);
    }
  });
});
