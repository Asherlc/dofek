import { describe, expect, it } from "vitest";
import { fitReadinessWeights, type ReadinessWeightsInput } from "./fit-readiness-weights.ts";

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate data where next-day HRV z-score is primarily driven by
 * specific component scores with known weights.
 */
function generateWeightsData(
  n: number,
  trueWeights: { hrv: number; restingHr: number; sleep: number; respiratoryRate: number },
  seed: number = 42,
): ReadinessWeightsInput[] {
  const rng = mulberry32(seed);
  const data: ReadinessWeightsInput[] = [];

  for (let i = 0; i < n; i++) {
    const hrvScore = 30 + rng() * 40;
    const rhrScore = 30 + rng() * 40;
    const sleepScore = 40 + rng() * 40;
    const respiratoryRateScore = 30 + rng() * 40;

    // Next-day HRV z-score driven by today's component scores with true weights
    const signal =
      trueWeights.hrv * hrvScore +
      trueWeights.restingHr * rhrScore +
      trueWeights.sleep * sleepScore +
      trueWeights.respiratoryRate * respiratoryRateScore;

    // Normalize to z-score-like range and add noise
    const nextDayHrvZScore = (signal - 50) / 15 + (rng() - 0.5) * 0.5;

    data.push({ hrvScore, rhrScore: rhrScore, sleepScore, respiratoryRateScore, nextDayHrvZScore });
  }

  return data;
}

describe("fitReadinessWeights", () => {
  it("returns null with insufficient data (< 60 days)", () => {
    const data = generateWeightsData(30, {
      hrv: 0.4,
      restingHr: 0.2,
      sleep: 0.2,
      respiratoryRate: 0.2,
    });
    expect(fitReadinessWeights(data)).toBeNull();
  });

  it("returns null with exactly 59 days (boundary below MIN_DAYS)", () => {
    const data = generateWeightsData(59, {
      hrv: 0.4,
      restingHr: 0.2,
      sleep: 0.2,
      respiratoryRate: 0.2,
    });
    expect(fitReadinessWeights(data)).toBeNull();
  });

  it("processes exactly 60 days (boundary at MIN_DAYS)", () => {
    const data = generateWeightsData(
      60,
      { hrv: 0.7, restingHr: 0.1, sleep: 0.1, respiratoryRate: 0.1 },
      555,
    );
    const result = fitReadinessWeights(data);
    // Should not short-circuit on length check; may or may not pass quality gate
    if (result) {
      expect(result.sampleCount).toBe(60);
    }
  });

  it("returns null with empty data", () => {
    expect(fitReadinessWeights([])).toBeNull();
  });

  it("finds weights that emphasize the dominant component", () => {
    // HRV dominates heavily
    const data = generateWeightsData(
      120,
      { hrv: 0.7, restingHr: 0.1, sleep: 0.1, respiratoryRate: 0.1 },
      123,
    );
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    // HRV should have the highest weight
    expect(result.hrv).toBeGreaterThan(result.restingHr);
    expect(result.hrv).toBeGreaterThan(result.sleep);
    expect(result.hrv).toBeGreaterThan(result.respiratoryRate);
  });

  it("weights sum to 1.0", () => {
    const data = generateWeightsData(100, {
      hrv: 0.5,
      restingHr: 0.15,
      sleep: 0.2,
      respiratoryRate: 0.15,
    });
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    const sum = result.hrv + result.restingHr + result.sleep + result.respiratoryRate;
    expect(sum).toBeCloseTo(1.0, 2);
  });

  it("all weights are >= 0.05", () => {
    const data = generateWeightsData(100, {
      hrv: 0.85,
      restingHr: 0.05,
      sleep: 0.05,
      respiratoryRate: 0.05,
    });
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.hrv).toBeGreaterThanOrEqual(0.05);
    expect(result.restingHr).toBeGreaterThanOrEqual(0.05);
    expect(result.sleep).toBeGreaterThanOrEqual(0.05);
    expect(result.respiratoryRate).toBeGreaterThanOrEqual(0.05);
  });

  it("returns null when scores have no correlation with outcome", () => {
    const rng = mulberry32(789);
    const data: ReadinessWeightsInput[] = [];
    for (let i = 0; i < 100; i++) {
      data.push({
        hrvScore: rng() * 100,
        rhrScore: rng() * 100,
        sleepScore: rng() * 100,
        respiratoryRateScore: rng() * 100,
        nextDayHrvZScore: rng() * 4 - 2, // random, no relationship
      });
    }

    const result = fitReadinessWeights(data);
    expect(result).toBeNull();
  });

  it("output has correct shape", () => {
    const data = generateWeightsData(100, {
      hrv: 0.4,
      restingHr: 0.2,
      sleep: 0.2,
      respiratoryRate: 0.2,
    });
    const result = fitReadinessWeights(data);
    if (!result) return;

    expect(typeof result.hrv).toBe("number");
    expect(typeof result.restingHr).toBe("number");
    expect(typeof result.sleep).toBe("number");
    expect(typeof result.respiratoryRate).toBe("number");
    expect(typeof result.sampleCount).toBe("number");
    expect(typeof result.correlation).toBe("number");
  });

  it("correlation is rounded to 3 decimal places", () => {
    const data = generateWeightsData(100, {
      hrv: 0.5,
      restingHr: 0.15,
      sleep: 0.2,
      respiratoryRate: 0.15,
    });
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    const rounded = Math.round(result.correlation * 1000) / 1000;
    expect(result.correlation).toBe(rounded);
  });

  it("sampleCount matches input data length", () => {
    const data = generateWeightsData(
      120,
      { hrv: 0.7, restingHr: 0.1, sleep: 0.1, respiratoryRate: 0.1 },
      123,
    );
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.sampleCount).toBe(120);
  });

  it("correlation must be >= MIN_CORRELATION (0.15) to produce a result", () => {
    const data = generateWeightsData(
      120,
      { hrv: 0.7, restingHr: 0.1, sleep: 0.1, respiratoryRate: 0.1 },
      123,
    );
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.correlation).toBeGreaterThanOrEqual(0.15);
  });

  it("handles constant scores (zero variance) without crashing", () => {
    const data: ReadinessWeightsInput[] = [];
    for (let i = 0; i < 100; i++) {
      data.push({
        hrvScore: 50,
        rhrScore: 50,
        sleepScore: 50,
        respiratoryRateScore: 50,
        nextDayHrvZScore: 0,
      });
    }

    // With zero variance, Pearson correlation denominator is 0, so correlation = 0
    const result = fitReadinessWeights(data);
    expect(result).toBeNull();
  });

  it("picks the combination with highest positive correlation (not absolute)", () => {
    // The algorithm uses `correlation > bestCorrelation` (not abs), so it only
    // considers positive correlations. Generate data with strong positive relationship.
    const data = generateWeightsData(
      150,
      { hrv: 0.6, restingHr: 0.1, sleep: 0.15, respiratoryRate: 0.15 },
      222,
    );
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    // Correlation should be positive
    expect(result.correlation).toBeGreaterThan(0);
  });

  it("emphasizes sleep when sleep is the dominant driver", () => {
    // Sleep dominates
    const data = generateWeightsData(
      120,
      { hrv: 0.1, restingHr: 0.1, sleep: 0.7, respiratoryRate: 0.1 },
      333,
    );
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.sleep).toBeGreaterThan(result.hrv);
    expect(result.sleep).toBeGreaterThan(result.restingHr);
    expect(result.sleep).toBeGreaterThan(result.respiratoryRate);
  });

  it("emphasizes respiratoryRate when respiratoryRate is the dominant driver", () => {
    const data = generateWeightsData(
      120,
      { hrv: 0.1, restingHr: 0.1, sleep: 0.1, respiratoryRate: 0.7 },
      444,
    );
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.respiratoryRate).toBeGreaterThan(result.hrv);
    expect(result.respiratoryRate).toBeGreaterThan(result.restingHr);
    expect(result.respiratoryRate).toBeGreaterThan(result.sleep);
  });
});
