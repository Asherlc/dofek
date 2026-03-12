import { describe, expect, it } from "vitest";
import { GradientBoostedTrees } from "../gradient-boost.ts";

describe("GradientBoostedTrees", () => {
  it("fits a simple linear relationship", () => {
    const X = Array.from({ length: 50 }, (_, i) => [i]);
    const y = X.map(([x]) => 2 * (x ?? 0) + 1);

    const model = new GradientBoostedTrees({
      nEstimators: 50,
      maxDepth: 3,
      learningRate: 0.1,
      minSamplesLeaf: 2,
    });
    model.fit(X, y);

    // Should approximate the linear trend reasonably well
    const pred = model.predict([25]);
    expect(pred).toBeCloseTo(51, -1); // within ~10
  });

  it("captures a nonlinear step function", () => {
    const X = Array.from({ length: 100 }, (_, i) => [i]);
    const y = X.map(([x]) => ((x ?? 0) < 50 ? 10 : 30));

    const model = new GradientBoostedTrees({
      nEstimators: 50,
      maxDepth: 2,
      learningRate: 0.3,
      minSamplesLeaf: 2,
    });
    model.fit(X, y);

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
    expect(importances[0]).toBeGreaterThan(importances[1]! * 2);
  });

  it("computes R² on training data", () => {
    const rng = mulberry32(99);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 100; i++) {
      const x = rng() * 10;
      X.push([x]);
      y.push(2 * x + 1 + (rng() - 0.5));
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

  it("serializes and deserializes", () => {
    const X = Array.from({ length: 50 }, (_, i) => [i, i * 2]);
    const y = X.map(([x1, x2]) => (x1 ?? 0) + (x2 ?? 0));

    const model = new GradientBoostedTrees({
      nEstimators: 20,
      maxDepth: 3,
      learningRate: 0.1,
      minSamplesLeaf: 2,
    });
    model.fit(X, y);

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
