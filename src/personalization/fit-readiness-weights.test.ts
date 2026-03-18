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
  trueWeights: { hrv: number; restingHr: number; sleep: number; loadBalance: number },
  seed: number = 42,
): ReadinessWeightsInput[] {
  const rng = mulberry32(seed);
  const data: ReadinessWeightsInput[] = [];

  for (let i = 0; i < n; i++) {
    const hrvScore = 30 + rng() * 40;
    const rhrScore = 30 + rng() * 40;
    const sleepScore = 40 + rng() * 40;
    const loadBalanceScore = 30 + rng() * 40;

    // Next-day HRV z-score driven by today's component scores with true weights
    const signal =
      trueWeights.hrv * hrvScore +
      trueWeights.restingHr * rhrScore +
      trueWeights.sleep * sleepScore +
      trueWeights.loadBalance * loadBalanceScore;

    // Normalize to z-score-like range and add noise
    const nextDayHrvZScore = (signal - 50) / 15 + (rng() - 0.5) * 0.5;

    data.push({ hrvScore, rhrScore: rhrScore, sleepScore, loadBalanceScore, nextDayHrvZScore });
  }

  return data;
}

describe("fitReadinessWeights", () => {
  it("returns null with insufficient data (< 60 days)", () => {
    const data = generateWeightsData(30, {
      hrv: 0.4,
      restingHr: 0.2,
      sleep: 0.2,
      loadBalance: 0.2,
    });
    expect(fitReadinessWeights(data)).toBeNull();
  });

  it("returns null with empty data", () => {
    expect(fitReadinessWeights([])).toBeNull();
  });

  it("finds weights that emphasize the dominant component", () => {
    // HRV dominates heavily
    const data = generateWeightsData(
      120,
      { hrv: 0.7, restingHr: 0.1, sleep: 0.1, loadBalance: 0.1 },
      123,
    );
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    // HRV should have the highest weight
    expect(result.hrv).toBeGreaterThan(result.restingHr);
    expect(result.hrv).toBeGreaterThan(result.sleep);
    expect(result.hrv).toBeGreaterThan(result.loadBalance);
  });

  it("weights sum to 1.0", () => {
    const data = generateWeightsData(100, {
      hrv: 0.5,
      restingHr: 0.15,
      sleep: 0.2,
      loadBalance: 0.15,
    });
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    const sum = result.hrv + result.restingHr + result.sleep + result.loadBalance;
    expect(sum).toBeCloseTo(1.0, 2);
  });

  it("all weights are >= 0.05", () => {
    const data = generateWeightsData(100, {
      hrv: 0.85,
      restingHr: 0.05,
      sleep: 0.05,
      loadBalance: 0.05,
    });
    const result = fitReadinessWeights(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.hrv).toBeGreaterThanOrEqual(0.05);
    expect(result.restingHr).toBeGreaterThanOrEqual(0.05);
    expect(result.sleep).toBeGreaterThanOrEqual(0.05);
    expect(result.loadBalance).toBeGreaterThanOrEqual(0.05);
  });

  it("returns null when scores have no correlation with outcome", () => {
    const rng = mulberry32(789);
    const data: ReadinessWeightsInput[] = [];
    for (let i = 0; i < 100; i++) {
      data.push({
        hrvScore: rng() * 100,
        rhrScore: rng() * 100,
        sleepScore: rng() * 100,
        loadBalanceScore: rng() * 100,
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
      loadBalance: 0.2,
    });
    const result = fitReadinessWeights(data);
    if (!result) return;

    expect(typeof result.hrv).toBe("number");
    expect(typeof result.restingHr).toBe("number");
    expect(typeof result.sleep).toBe("number");
    expect(typeof result.loadBalance).toBe("number");
    expect(typeof result.sampleCount).toBe("number");
    expect(typeof result.correlation).toBe("number");
  });
});
