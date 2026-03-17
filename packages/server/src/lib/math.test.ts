import { describe, expect, it } from "vitest";
import { fitCriticalPower, linearRegression } from "./math.ts";

describe("linearRegression", () => {
  it("fits a perfect line", () => {
    const { slope, intercept, r2 } = linearRegression([1, 2, 3], [2, 4, 6]);
    expect(slope).toBeCloseTo(2);
    expect(intercept).toBeCloseTo(0);
    expect(r2).toBeCloseTo(1);
  });

  it("fits a line with nonzero intercept", () => {
    // y = 3x + 5
    const { slope, intercept, r2 } = linearRegression([1, 2, 3, 4], [8, 11, 14, 17]);
    expect(slope).toBeCloseTo(3);
    expect(intercept).toBeCloseTo(5);
    expect(r2).toBeCloseTo(1);
  });

  it("returns zero slope and intercept for degenerate input", () => {
    // All same x — denom is 0
    const { slope, intercept, r2 } = linearRegression([5, 5, 5], [1, 2, 3]);
    expect(slope).toBe(0);
    expect(intercept).toBe(0);
    expect(r2).toBe(0);
  });

  it("returns low r2 for noisy data", () => {
    const { r2 } = linearRegression([1, 2, 3, 4, 5], [10, 1, 8, 2, 9]);
    expect(r2).toBeLessThan(0.5);
  });

  it("handles negative slopes", () => {
    // y = -2x + 10
    const { slope, intercept } = linearRegression([1, 2, 3], [8, 6, 4]);
    expect(slope).toBeCloseTo(-2);
    expect(intercept).toBeCloseTo(10);
  });
});

describe("fitCriticalPower", () => {
  /**
   * Generate a power curve from a known CP model: P(t) = CP + W'/t
   */
  function powerCurve(
    cp: number,
    wPrime: number,
    durations: number[],
  ): { durationSeconds: number; bestPower: number }[] {
    return durations.map((t) => ({
      durationSeconds: t,
      bestPower: cp + wPrime / t,
    }));
  }

  it("recovers CP from ideal power curve data", () => {
    const points = powerCurve(230, 15000, [120, 300, 600]);
    const model = fitCriticalPower(points);
    expect(model).not.toBeNull();
    expect(model?.cp).toBeCloseTo(230, 0);
    expect(model?.wPrime).toBeCloseTo(15000, -2);
    expect(model?.r2).toBeGreaterThan(0.99);
  });

  it("ignores long-duration data suppressed by interval training", () => {
    // Short durations reflect true maximal efforts (CP=230, W'=15000)
    const shortDurations = powerCurve(230, 15000, [120, 300, 600]);

    // Long durations are suppressed by interval recovery periods —
    // average power over 20–60 min includes rest, so it's well below
    // what the athlete could sustain in a maximal steady-state effort
    const suppressedLongDurations = [
      { durationSeconds: 1200, bestPower: 200 }, // would be 242.5 at true max
      { durationSeconds: 1800, bestPower: 185 }, // would be 238.3 at true max
      { durationSeconds: 3600, bestPower: 170 }, // would be 234.2 at true max
    ];

    const model = fitCriticalPower([...shortDurations, ...suppressedLongDurations]);
    expect(model).not.toBeNull();
    // Should still estimate ~230W, not be pulled down by suppressed long-duration data
    expect(model?.cp).toBeCloseTo(230, 0);
  });

  it("returns null with fewer than 3 valid points", () => {
    const points = powerCurve(230, 15000, [120, 300]);
    expect(fitCriticalPower(points)).toBeNull();
  });

  it("returns null when CP would be negative", () => {
    // Nonsensical data where work decreases with time
    const points = [
      { durationSeconds: 120, bestPower: 300 },
      { durationSeconds: 300, bestPower: 200 },
      { durationSeconds: 600, bestPower: 50 },
    ];
    const model = fitCriticalPower(points);
    // Either null or positive CP — the model should not return negative CP
    if (model) {
      expect(model.cp).toBeGreaterThan(0);
    }
  });

  it("excludes durations under 120s", () => {
    // Only sub-120s data — should return null
    const points = [
      { durationSeconds: 5, bestPower: 800 },
      { durationSeconds: 15, bestPower: 600 },
      { durationSeconds: 30, bestPower: 500 },
      { durationSeconds: 60, bestPower: 400 },
    ];
    expect(fitCriticalPower(points)).toBeNull();
  });

  it("excludes durations over 600s from fitting", () => {
    const points = [
      { durationSeconds: 700, bestPower: 230 },
      { durationSeconds: 1200, bestPower: 220 },
      { durationSeconds: 1800, bestPower: 210 },
    ];
    expect(fitCriticalPower(points)).toBeNull();
  });

  it("excludes points with zero power", () => {
    const points = [
      { durationSeconds: 120, bestPower: 0 },
      { durationSeconds: 300, bestPower: 0 },
      { durationSeconds: 600, bestPower: 0 },
    ];
    expect(fitCriticalPower(points)).toBeNull();
  });

  it("includes boundary durations 120s and 600s", () => {
    const points = powerCurve(250, 20000, [120, 360, 600]);
    const model = fitCriticalPower(points);
    expect(model).not.toBeNull();
    expect(model?.cp).toBeCloseTo(250, 0);
  });

  it("rounds cp, wPrime, and r2 values", () => {
    const points = powerCurve(230, 15000, [120, 180, 240, 300, 420, 600]);
    const model = fitCriticalPower(points);
    expect(model).not.toBeNull();
    // CP and wPrime should be rounded integers
    expect(Number.isInteger(model?.cp)).toBe(true);
    expect(Number.isInteger(model?.wPrime)).toBe(true);
    // r2 should be rounded to 3 decimal places
    const r2Str = String(model?.r2);
    const decimals = r2Str.split(".")[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(3);
  });

  it("returns null for empty input", () => {
    expect(fitCriticalPower([])).toBeNull();
  });
});
