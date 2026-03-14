import { describe, expect, it } from "vitest";
import { fitCriticalPower, linearRegression } from "./math.ts";

describe("linearRegression", () => {
  it("fits a perfect line", () => {
    const { slope, intercept, r2 } = linearRegression([1, 2, 3], [2, 4, 6]);
    expect(slope).toBeCloseTo(2);
    expect(intercept).toBeCloseTo(0);
    expect(r2).toBeCloseTo(1);
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
});
