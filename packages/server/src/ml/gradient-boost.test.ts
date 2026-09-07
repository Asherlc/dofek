import { describe, expect, it } from "vitest";
import { GradientBoostedTrees } from "./gradient-boost.ts";

describe("GradientBoostedTrees", () => {
  it("fits a simple linear relationship", () => {
    const featureMatrix = Array.from({ length: 50 }, (_, i) => [i]);
    const targets = featureMatrix.map(([x]) => 2 * (x ?? 0) + 1);

    const model = new GradientBoostedTrees({
      nEstimators: 50,
      maxDepth: 3,
      learningRate: 0.1,
      minSamplesLeaf: 2,
    });
    model.fit(featureMatrix, targets);

    // Should approximate the linear trend reasonably well
    const pred = model.predict([25]);
    expect(pred).toBeCloseTo(51, -1); // within ~10
  });

  it("captures a nonlinear step function", () => {
    const featureMatrix = Array.from({ length: 100 }, (_, i) => [i]);
    const targets = featureMatrix.map(([x]) => ((x ?? 0) < 50 ? 10 : 30));

    const model = new GradientBoostedTrees({
      nEstimators: 50,
      maxDepth: 2,
      learningRate: 0.3,
      minSamplesLeaf: 2,
    });
    model.fit(featureMatrix, targets);

    expect(model.predict([20])).toBeCloseTo(10, -1);
    expect(model.predict([80])).toBeCloseTo(30, -1);
  });

  it("captures interaction effects that linear regression cannot", () => {
    // y = x1 * x2 (pure interaction, no main effects)
    const rng = mulberry32(123);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 200; i++) {
      const x1 = rng() * 10;
      const x2 = rng() * 10;
      X.push([x1, x2]);
      y.push(x1 * x2);
    }

    const model = new GradientBoostedTrees({
      nEstimators: 100,
      maxDepth: 4,
      learningRate: 0.1,
      minSamplesLeaf: 5,
    });
    model.fit(X, y);

    // Test a few points
    const pred1 = model.predict([5, 5]);
    expect(pred1).toBeCloseTo(25, -1);

    const pred2 = model.predict([2, 8]);
    expect(pred2).toBeCloseTo(16, -1);
  });

  it("computes feature importances", () => {
    // x1 is the main driver, x2 is noise
    const rng = mulberry32(42);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 100; i++) {
      const x1 = rng() * 10;
      const x2 = rng() * 10;
      X.push([x1, x2]);
      y.push(3 * x1 + (rng() - 0.5) * 0.1);
    }

    const model = new GradientBoostedTrees({
      nEstimators: 50,
      maxDepth: 3,
      learningRate: 0.1,
      minSamplesLeaf: 2,
    });
    model.fit(X, y);

    const importances = model.featureImportances;
    expect(importances).toHaveLength(2);
    // x1 should have much higher importance than x2
    const secondImportance = importances[1];
    if (secondImportance === undefined) throw new Error("expected second importance");
    expect(importances[0]).toBeGreaterThan(secondImportance * 2);
  });

  it("computes R² on training data", () => {
    const rng = mulberry32(99);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 100; i++) {
      const featureValue = rng() * 10;
      X.push([featureValue]);
      y.push(2 * featureValue + 1 + (rng() - 0.5));
    }

    const model = new GradientBoostedTrees({
      nEstimators: 50,
      maxDepth: 3,
      learningRate: 0.1,
      minSamplesLeaf: 2,
    });
    model.fit(X, y);

    expect(model.rSquared).toBeGreaterThan(0.9);
  });

  it("throws if X and y have different lengths", () => {
    const model = new GradientBoostedTrees();
    expect(() => model.fit([[1], [2]], [1])).toThrow();
  });

  it("keeps a constant target as a leaf model with zero feature importance", () => {
    const model = new GradientBoostedTrees({
      nEstimators: 3,
      maxDepth: 3,
      learningRate: 0.2,
      minSamplesLeaf: 1,
    });

    model.fit([[1], [2], [3], [4]], [7, 7, 7, 7]);

    expect(model.predict([99])).toBe(7);
    expect(model.rSquared).toBe(1);
    expect(model.featureImportances).toEqual([0]);
  });

  it("uses a mean leaf when a feature has no distinct split", () => {
    const model = new GradientBoostedTrees({
      nEstimators: 1,
      maxDepth: 3,
      learningRate: 1,
      minSamplesLeaf: 1,
    });

    model.fit([[4], [4], [4]], [2, 5, 8]);

    expect(model.predict([4])).toBeCloseTo(5, 10);
    expect(model.featureImportances).toEqual([0]);
  });

  it("serializes and deserializes", () => {
    const featureMatrix = Array.from({ length: 50 }, (_, i) => [i, i * 2]);
    const targets = featureMatrix.map(([x1, x2]) => (x1 ?? 0) + (x2 ?? 0));

    const model = new GradientBoostedTrees({
      nEstimators: 20,
      maxDepth: 3,
      learningRate: 0.1,
      minSamplesLeaf: 2,
    });
    model.fit(featureMatrix, targets);

    const json = model.toJSON();
    const restored = GradientBoostedTrees.fromJSON(json);

    expect(restored.predict([10, 20])).toBeCloseTo(model.predict([10, 20]), 10);
    expect(restored.featureImportances).toEqual(model.featureImportances);
  });
});

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
