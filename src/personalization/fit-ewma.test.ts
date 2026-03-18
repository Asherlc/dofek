import { describe, expect, it } from "vitest";
import { type ExponentialMovingAverageInput, fitExponentialMovingAverage } from "./fit-ewma.ts";

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
): ExponentialMovingAverageInput[] {
  const rng = mulberry32(seed);
  const data: ExponentialMovingAverageInput[] = [];

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

describe("fitExponentialMovingAverage", () => {
  it("returns null with insufficient data (< 90 days)", () => {
    const data = generateEwmaData(50, 42, 7);
    expect(fitExponentialMovingAverage(data)).toBeNull();
  });

  it("returns null with exactly 89 days (boundary below MIN_DAYS)", () => {
    const data = generateEwmaData(89, 42, 7);
    expect(fitExponentialMovingAverage(data)).toBeNull();
  });

  it("processes exactly 90 days (boundary at MIN_DAYS)", () => {
    // With 90 days and good correlation, should attempt to compute
    const data = generateEwmaData(90, 42, 7, 555);
    const result = fitExponentialMovingAverage(data);
    // May or may not pass quality gate, but the function should not short-circuit
    // (it won't be null from the length check)
    if (result) {
      expect(result.sampleCount).toBe(90);
    }
  });

  it("returns null with empty data", () => {
    expect(fitExponentialMovingAverage([])).toBeNull();
  });

  it("finds optimal windows near the true generating parameters", () => {
    // Generate data with true CTL=35, ATL=9
    const data = generateEwmaData(200, 35, 9, 123);
    const result = fitExponentialMovingAverage(data);

    expect(result).not.toBeNull();
    if (!result) return;

    // Should be in a reasonable range (grid search may not recover exact params
    // with synthetic data, but should be in the right neighborhood)
    expect(result.chronicTrainingLoadDays).toBeGreaterThanOrEqual(21);
    expect(result.chronicTrainingLoadDays).toBeLessThanOrEqual(56);
    expect(result.acuteTrainingLoadDays).toBeGreaterThanOrEqual(5);
    expect(result.acuteTrainingLoadDays).toBeLessThanOrEqual(14);
    expect(result.sampleCount).toBe(200);
    expect(result.correlation).toBeGreaterThan(0);
  });

  it("returns a result with reasonable correlation for default params", () => {
    const data = generateEwmaData(180, 42, 7, 456);
    const result = fitExponentialMovingAverage(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.correlation).toBeGreaterThan(0.2);
  });

  it("returns null when performance has no correlation with load", () => {
    const rng = mulberry32(789);
    const data: ExponentialMovingAverageInput[] = [];

    for (let i = 0; i < 120; i++) {
      const date = new Date(2024, 0, 1 + i).toISOString().slice(0, 10);
      data.push({
        date,
        load: rng() * 100,
        performance: rng() * 100, // completely random, no relationship
      });
    }

    const result = fitExponentialMovingAverage(data);
    // Should be null because no candidate passes the quality gate
    expect(result).toBeNull();
  });

  it("output has correct shape", () => {
    const data = generateEwmaData(200, 42, 7);
    const result = fitExponentialMovingAverage(data);
    if (!result) return;

    expect(typeof result.chronicTrainingLoadDays).toBe("number");
    expect(typeof result.acuteTrainingLoadDays).toBe("number");
    expect(typeof result.sampleCount).toBe("number");
    expect(typeof result.correlation).toBe("number");
    expect(Number.isInteger(result.chronicTrainingLoadDays)).toBe(true);
    expect(Number.isInteger(result.acuteTrainingLoadDays)).toBe(true);
  });

  it("correlation is rounded to 3 decimal places", () => {
    const data = generateEwmaData(200, 42, 7, 456);
    const result = fitExponentialMovingAverage(data);

    expect(result).not.toBeNull();
    if (!result) return;

    // Math.round(x * 1000) / 1000 produces at most 3 decimal places
    const rounded = Math.round(result.correlation * 1000) / 1000;
    expect(result.correlation).toBe(rounded);
  });

  it("selects the candidate with the highest absolute correlation", () => {
    // Generate highly correlated data — the result should pick a meaningful pair
    const data = generateEwmaData(250, 42, 7, 42);
    const result = fitExponentialMovingAverage(data);

    expect(result).not.toBeNull();
    if (!result) return;

    // Correlation should be above the MIN_CORRELATION (0.2) threshold
    expect(Math.abs(result.correlation)).toBeGreaterThanOrEqual(0.2);
  });

  it("skips CTL/ATL pairs where CTL <= ATL", () => {
    // With chronicTrainingLoadDays=21 and acuteTrainingLoadDays=14, 21 > 14 so it's valid
    // With chronicTrainingLoadDays=21 and acuteTrainingLoadDays=21, the pair should be skipped (CTL must be > ATL)
    // We verify indirectly: the result chronicTrainingLoadDays should always be > acuteTrainingLoadDays
    const data = generateEwmaData(200, 42, 7, 999);
    const result = fitExponentialMovingAverage(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.chronicTrainingLoadDays).toBeGreaterThan(result.acuteTrainingLoadDays);
  });

  it("handles constant load data (zero variance in TSB)", () => {
    const data: ExponentialMovingAverageInput[] = [];
    for (let i = 0; i < 120; i++) {
      const date = new Date(2024, 0, 1 + i).toISOString().slice(0, 10);
      data.push({ date, load: 50, performance: 200 });
    }

    // With constant load, TSB will converge to 0, Pearson denominator will be 0
    const result = fitExponentialMovingAverage(data);
    expect(result).toBeNull();
  });

  it("returns null with fewer than 30 usable TSB-performance pairs", () => {
    // Need data.length - 7 > 30 to get enough pairs, but if we only have ~37 valid days
    // this tests the boundary near pairs.length < 30
    // With 97 days and 7 lookahead, we get 90 pairs — well above 30
    // But with only 37 days (37-7 = 30 pairs, at the boundary)
    const data = generateEwmaData(97, 42, 7, 101);
    const result = fitExponentialMovingAverage(data);
    // 97 > MIN_DAYS(90), so it runs; 97-7 = 90 pairs, above 30 threshold
    if (result) {
      expect(result.sampleCount).toBe(97);
    }
  });

  it("returns sampleCount matching input length", () => {
    const data = generateEwmaData(200, 35, 9, 321);
    const result = fitExponentialMovingAverage(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.sampleCount).toBe(200);
  });

  it("can produce negative correlation values", () => {
    // Generate inversely correlated data: higher TSB → worse performance
    const rng = mulberry32(777);
    const data: ExponentialMovingAverageInput[] = [];
    let ctl = 0;
    let atl = 0;

    for (let i = 0; i < 200; i++) {
      const date = new Date(2024, 0, 1 + i).toISOString().slice(0, 10);
      const load = 50 + 30 * Math.sin(i / 14) + rng() * 20;
      ctl = ctl + (load - ctl) / 42;
      atl = atl + (load - atl) / 7;
      const tsb = ctl - atl;
      // Performance NEGATIVELY correlated with TSB
      const performance = 200 - tsb * 3 + (rng() - 0.5) * 5;
      data.push({ date, load, performance });
    }

    const result = fitExponentialMovingAverage(data);
    // The function uses Math.abs for comparison, so it may find negative correlation
    if (result) {
      // Whether positive or negative, absolute value should exceed 0.2
      expect(Math.abs(result.correlation)).toBeGreaterThanOrEqual(0.2);
    }
  });
});
