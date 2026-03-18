import { describe, expect, it } from "vitest";
import { type EwmaInput, fitEwma } from "./fit-ewma.ts";

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
 * Generate synthetic data where a specific CTL/ATL window produces
 * the best TSB-performance correlation.
 * The true response model uses ctlTrue/atlTrue to compute TSB,
 * and performance = baseline + factor * TSB + noise.
 */
function generateEwmaData(
  n: number,
  ctlTrue: number,
  atlTrue: number,
  seed: number = 42,
): EwmaInput[] {
  const rng = mulberry32(seed);
  const data: EwmaInput[] = [];

  let ctl = 0;
  let atl = 0;

  for (let i = 0; i < n; i++) {
    const date = new Date(2024, 0, 1 + i).toISOString().slice(0, 10);
    // Simulate training with periodic load pattern
    const load = 50 + 30 * Math.sin(i / 14) + rng() * 20;

    ctl = ctl + (load - ctl) / ctlTrue;
    atl = atl + (load - atl) / atlTrue;
    const tsb = ctl - atl;

    // Performance positively correlated with TSB (supercompensation)
    const performance = 200 + tsb * 2 + (rng() - 0.5) * 10;

    data.push({ date, load, performance });
  }

  return data;
}

describe("fitEwma", () => {
  it("returns null with insufficient data (< 90 days)", () => {
    const data = generateEwmaData(50, 42, 7);
    expect(fitEwma(data)).toBeNull();
  });

  it("returns null with empty data", () => {
    expect(fitEwma([])).toBeNull();
  });

  it("finds optimal windows near the true generating parameters", () => {
    // Generate data with true CTL=35, ATL=9
    const data = generateEwmaData(200, 35, 9, 123);
    const result = fitEwma(data);

    expect(result).not.toBeNull();
    if (!result) return;

    // Should be in a reasonable range (grid search may not recover exact params
    // with synthetic data, but should be in the right neighborhood)
    expect(result.ctlDays).toBeGreaterThanOrEqual(21);
    expect(result.ctlDays).toBeLessThanOrEqual(56);
    expect(result.atlDays).toBeGreaterThanOrEqual(5);
    expect(result.atlDays).toBeLessThanOrEqual(14);
    expect(result.sampleCount).toBe(200);
    expect(result.correlation).toBeGreaterThan(0);
  });

  it("returns a result with reasonable correlation for default params", () => {
    const data = generateEwmaData(180, 42, 7, 456);
    const result = fitEwma(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.correlation).toBeGreaterThan(0.2);
  });

  it("returns null when performance has no correlation with load", () => {
    const rng = mulberry32(789);
    const data: EwmaInput[] = [];

    for (let i = 0; i < 120; i++) {
      const date = new Date(2024, 0, 1 + i).toISOString().slice(0, 10);
      data.push({
        date,
        load: rng() * 100,
        performance: rng() * 100, // completely random, no relationship
      });
    }

    const result = fitEwma(data);
    // Should be null because no candidate passes the quality gate
    expect(result).toBeNull();
  });

  it("output has correct shape", () => {
    const data = generateEwmaData(200, 42, 7);
    const result = fitEwma(data);
    if (!result) return;

    expect(typeof result.ctlDays).toBe("number");
    expect(typeof result.atlDays).toBe("number");
    expect(typeof result.sampleCount).toBe("number");
    expect(typeof result.correlation).toBe("number");
    expect(Number.isInteger(result.ctlDays)).toBe(true);
    expect(Number.isInteger(result.atlDays)).toBe(true);
  });
});
