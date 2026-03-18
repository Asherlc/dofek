import { describe, expect, it } from "vitest";
import { fitStressThresholds, type StressThresholdsInput } from "./fit-stress-thresholds.ts";

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

function generateZScores(n: number, seed: number = 42): StressThresholdsInput[] {
  const rng = mulberry32(seed);
  const data: StressThresholdsInput[] = [];

  for (let i = 0; i < n; i++) {
    // Generate approximately normally distributed z-scores using Box-Muller
    const u1 = rng();
    const u2 = rng();
    const hrvZ = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    const u3 = rng();
    const u4 = rng();
    const rhrZ = Math.sqrt(-2 * Math.log(u3)) * Math.cos(2 * Math.PI * u4);

    data.push({ hrvZScore: hrvZ, rhrZScore: rhrZ });
  }

  return data;
}

describe("fitStressThresholds", () => {
  it("returns null with insufficient data (< 60 days)", () => {
    const data = generateZScores(30);
    expect(fitStressThresholds(data)).toBeNull();
  });

  it("returns null with empty data", () => {
    expect(fitStressThresholds([])).toBeNull();
  });

  it("produces thresholds based on percentile distribution", () => {
    const data = generateZScores(200, 123);
    const result = fitStressThresholds(data);

    expect(result).not.toBeNull();
    if (!result) return;

    // HRV thresholds should be in ascending order (most negative first)
    const [h0, h1, h2] = result.hrvThresholds;
    expect(h0).toBeLessThan(h1);
    expect(h1).toBeLessThan(h2);

    // RHR thresholds should be in descending order (most positive first)
    const [r0, r1, r2] = result.rhrThresholds;
    expect(r0).toBeGreaterThan(r1);
    expect(r1).toBeGreaterThan(r2);

    // For approximately normal data, thresholds should be reasonable
    // h0 (10th percentile) should be negative, h2 (60th percentile) can be positive
    expect(h0).toBeLessThan(0);
    expect(h0).toBeLessThan(h2);
    expect(r0).toBeGreaterThan(0);
    expect(r0).toBeGreaterThan(r2);

    expect(result.sampleCount).toBe(200);
  });

  it("adapts to wider distributions", () => {
    // Wide HRV distribution
    const rng = mulberry32(456);
    const data: StressThresholdsInput[] = [];
    for (let i = 0; i < 100; i++) {
      const u1 = rng();
      const u2 = rng();
      const hrvZ = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * 2; // wider
      const rhrZ = Math.sqrt(-2 * Math.log(rng())) * Math.cos(2 * Math.PI * rng());
      data.push({ hrvZScore: hrvZ, rhrZScore: rhrZ });
    }

    const result = fitStressThresholds(data);
    expect(result).not.toBeNull();
    if (!result) return;

    // Thresholds should be further apart for wider distribution
    const narrow = fitStressThresholds(generateZScores(100, 456));
    if (narrow) {
      expect(Math.abs(result.hrvThresholds[0])).toBeGreaterThan(
        Math.abs(narrow.hrvThresholds[0]) * 0.8,
      );
    }
  });

  it("output thresholds are rounded to 2 decimal places", () => {
    const data = generateZScores(100, 789);
    const result = fitStressThresholds(data);
    if (!result) return;

    for (const t of result.hrvThresholds) {
      expect(Math.round(t * 100) / 100).toBe(t);
    }
    for (const t of result.rhrThresholds) {
      expect(Math.round(t * 100) / 100).toBe(t);
    }
  });
});
