import { describe, expect, it } from "vitest";
import { LinearRegression } from "./regression.ts";

describe("LinearRegression", () => {
  it("fits a perfect linear relationship y = 2x + 1", () => {
    const featureMatrix = [[1], [2], [3], [4], [5]];
    const targets = [3, 5, 7, 9, 11];

    const model = new LinearRegression();
    model.fit(featureMatrix, targets);

    expect(model.coefficients).toHaveLength(1);
    expect(model.coefficients[0]).toBeCloseTo(2, 5);
    expect(model.intercept).toBeCloseTo(1, 5);
    expect(model.rSquared).toBeCloseTo(1, 5);
  });

  it("fits a multivariate relationship y = 3x1 + 2x2 - 1", () => {
    const featureMatrix = [
      [1, 1],
      [2, 1],
      [1, 2],
      [3, 2],
      [2, 3],
      [4, 1],
      [3, 3],
      [5, 2],
    ];
    const targets = featureMatrix.map(([x1, x2]) => 3 * (x1 ?? 0) + 2 * (x2 ?? 0) - 1);

    const model = new LinearRegression();
    model.fit(featureMatrix, targets);

    expect(model.coefficients[0]).toBeCloseTo(3, 4);
    expect(model.coefficients[1]).toBeCloseTo(2, 4);
    expect(model.intercept).toBeCloseTo(-1, 4);
    expect(model.rSquared).toBeCloseTo(1, 4);
  });

  it("predicts new values", () => {
    const featureMatrix = [[1], [2], [3], [4], [5]];
    const targets = [3, 5, 7, 9, 11];

    const model = new LinearRegression();
    model.fit(featureMatrix, targets);

    expect(model.predict([6])).toBeCloseTo(13, 5);
    expect(model.predict([0])).toBeCloseTo(1, 5);
  });

  it("computes feature importances as standardized coefficients", () => {
    // x1 has large values but small coefficient, x2 is independent with large coefficient
    const rng = mulberry32(77);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 30; i++) {
      const x1 = 100 + rng() * 400;
      const x2 = rng() * 5;
      X.push([x1, x2]);
      y.push(0.01 * x1 + 10 * x2);
    }

    const model = new LinearRegression();
    model.fit(X, y);

    // Both features contribute roughly equally when standardized
    const importances = model.featureImportances;
    expect(importances).toHaveLength(2);
    // Both should be positive (both positively correlated with y)
    expect(importances[0]).toBeGreaterThan(0);
    expect(importances[1]).toBeGreaterThan(0);
  });

  it("handles noisy data with reasonable R²", () => {
    // y ≈ 2x + noise
    const rng = mulberry32(42);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 100; i++) {
      const featureValue = rng() * 10;
      X.push([featureValue]);
      y.push(2 * featureValue + 1 + (rng() - 0.5) * 2);
    }

    const model = new LinearRegression();
    model.fit(X, y);

    expect(model.coefficients[0]).toBeCloseTo(2, 0);
    expect(model.intercept).toBeCloseTo(1, 0);
    expect(model.rSquared).toBeGreaterThan(0.9);
    expect(model.rSquared).toBeLessThanOrEqual(1);
  });

  it("returns adjusted R²", () => {
    const featureMatrix = [[1], [2], [3], [4], [5]];
    const targets = [3, 5, 7, 9, 11];

    const model = new LinearRegression();
    model.fit(featureMatrix, targets);

    // For a perfect fit, adjusted R² should also be ~1
    expect(model.adjustedRSquared).toBeCloseTo(1, 4);
  });

  it("throws if X and y have different lengths", () => {
    const model = new LinearRegression();
    expect(() => model.fit([[1], [2]], [1])).toThrow();
  });

  it("throws if fewer samples than features", () => {
    const model = new LinearRegression();
    expect(() => model.fit([[1, 2, 3]], [1])).toThrow();
  });

  it("serializes and deserializes", () => {
    const featureMatrix = [[1], [2], [3], [4], [5]];
    const targets = [3, 5, 7, 9, 11];

    const model = new LinearRegression();
    model.fit(featureMatrix, targets);

    const json = model.toJSON();
    const restored = LinearRegression.fromJSON(json);

    expect(restored.predict([6])).toBeCloseTo(model.predict([6]), 10);
    expect(restored.rSquared).toBeCloseTo(model.rSquared, 10);
    expect(restored.coefficients).toEqual(model.coefficients);
  });
});

// Simple deterministic PRNG for reproducible tests
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
