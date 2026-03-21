import { describe as d, expect, it } from "vitest";
import { benjaminiHochberg, cohensD, describe, spearmanCorrelation, welchTTest } from "./stats.ts";

d("describe()", () => {
  it("returns zeroed stats for empty array", () => {
    const result = describe([]);
    expect(result).toEqual({ mean: 0, median: 0, stddev: 0, p25: 0, p75: 0, n: 0 });
  });

  it("returns correct stats for single value", () => {
    const result = describe([42]);
    expect(result.mean).toBe(42);
    expect(result.median).toBe(42);
    expect(result.stddev).toBe(0);
    expect(result.n).toBe(1);
  });

  it("computes correct descriptive stats for known set", () => {
    const result = describe([1, 2, 3, 4, 5]);
    expect(result.mean).toBe(3);
    expect(result.median).toBe(3);
    expect(result.n).toBe(5);
    // simple-statistics uses population stddev: sqrt(2)
    expect(result.stddev).toBeCloseTo(Math.sqrt(2), 3);
    expect(result.p25).toBeCloseTo(2, 0);
    expect(result.p75).toBeCloseTo(4, 0);
  });

  it("handles unsorted input correctly", () => {
    const result = describe([5, 1, 3, 2, 4]);
    expect(result.mean).toBe(3);
    expect(result.median).toBe(3);
  });

  it("handles two identical values", () => {
    const result = describe([7, 7]);
    expect(result.mean).toBe(7);
    expect(result.median).toBe(7);
    expect(result.stddev).toBe(0);
  });
});

d("welchTTest()", () => {
  it("returns neutral result for groups with < 2 elements", () => {
    const result = welchTTest([1], [2, 3]);
    expect(result.t).toBe(0);
    expect(result.pValue).toBe(1);
  });

  it("returns pValue near 1.0 for identical groups", () => {
    const groupA = [10, 10, 10, 10, 10];
    const groupB = [10, 10, 10, 10, 10];
    const result = welchTTest(groupA, groupB);
    expect(result.t).toBe(0);
    expect(result.pValue).toBe(1);
  });

  it("returns low pValue for clearly different groups", () => {
    const groupA = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
    const groupB = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const result = welchTTest(groupA, groupB);
    expect(result.pValue).toBeLessThan(0.001);
    expect(result.t).toBeGreaterThan(0); // groupA has higher mean
    expect(result.df).toBeGreaterThan(0);
  });

  it("handles groups with zero variance (se=0)", () => {
    const groupA = [5, 5, 5];
    const groupB = [5, 5, 5];
    const result = welchTTest(groupA, groupB);
    expect(result.pValue).toBe(1);
    expect(result.t).toBe(0);
  });
});

d("cohensD()", () => {
  it("returns 0 for groups with < 2 elements", () => {
    expect(cohensD([1], [2, 3])).toBe(0);
    expect(cohensD([1, 2], [3])).toBe(0);
  });

  it("returns 0 for identical groups", () => {
    expect(cohensD([5, 5, 5], [5, 5, 5])).toBe(0);
  });

  it("returns positive d when group a has higher mean", () => {
    const effectSize = cohensD([10, 11, 12], [1, 2, 3]);
    expect(effectSize).toBeGreaterThan(0);
  });

  it("returns negative d when group a has lower mean", () => {
    const effectSize = cohensD([1, 2, 3], [10, 11, 12]);
    expect(effectSize).toBeLessThan(0);
  });

  it("returns large d (≈ 2.0+) for well-separated groups", () => {
    // Mean diff = 10, pooled SD ≈ 1.58 → d ≈ 6.3
    const effectSize = cohensD([10, 11, 12, 13, 14], [0, 1, 2, 3, 4]);
    expect(Math.abs(effectSize)).toBeGreaterThan(2);
  });
});

d("spearmanCorrelation()", () => {
  it("returns neutral result for n < 5", () => {
    const result = spearmanCorrelation([1, 2, 3], [3, 2, 1]);
    expect(result.rho).toBe(0);
    expect(result.pValue).toBe(1);
    expect(result.n).toBe(3);
  });

  it("returns rho near 1.0 for perfectly monotonic increasing", () => {
    const result = spearmanCorrelation([1, 2, 3, 4, 5, 6, 7], [10, 20, 30, 40, 50, 60, 70]);
    expect(result.rho).toBeCloseTo(1.0, 2);
    expect(result.pValue).toBeLessThan(0.05);
  });

  it("returns rho near -1.0 for perfectly monotonic decreasing", () => {
    const result = spearmanCorrelation([1, 2, 3, 4, 5, 6, 7], [70, 60, 50, 40, 30, 20, 10]);
    expect(result.rho).toBeCloseTo(-1.0, 2);
    expect(result.pValue).toBeLessThan(0.05);
  });

  it("returns rho near 0 for unrelated data", () => {
    // Alternating pattern with no monotonic relationship
    const xValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const yValues = [5, 1, 5, 1, 5, 1, 5, 1, 5, 1];
    const result = spearmanCorrelation(xValues, yValues);
    expect(Math.abs(result.rho)).toBeLessThan(0.5);
  });
});

d("benjaminiHochberg()", () => {
  it("returns all false when all p-values exceed alpha", () => {
    const result = benjaminiHochberg([0.5, 0.6, 0.7, 0.8], 0.05);
    expect(result).toEqual([false, false, false, false]);
  });

  it("returns all true when all p-values are 0", () => {
    const result = benjaminiHochberg([0, 0, 0, 0], 0.05);
    expect(result).toEqual([true, true, true, true]);
  });

  it("correctly handles a known mixed case", () => {
    // 5 tests with p-values: [0.005, 0.01, 0.03, 0.04, 0.5]
    // BH threshold at alpha=0.05: k/5 * 0.05 → [0.01, 0.02, 0.03, 0.04, 0.05]
    // p[0]=0.005 <= 0.01 ✓, p[1]=0.01 <= 0.02 ✓, p[2]=0.03 <= 0.03 ✓, p[3]=0.04 <= 0.04 ✓, p[4]=0.5 > 0.05 ✗
    // maxK = 3, so indices 0..3 are significant
    const pValues = [0.03, 0.5, 0.005, 0.04, 0.01]; // unsorted input
    const result = benjaminiHochberg(pValues, 0.05);
    // Original indices: 0.03→idx0, 0.5→idx1, 0.005→idx2, 0.04→idx3, 0.01→idx4
    expect(result[0]).toBe(true); // 0.03
    expect(result[1]).toBe(false); // 0.5
    expect(result[2]).toBe(true); // 0.005
    expect(result[3]).toBe(true); // 0.04
    expect(result[4]).toBe(true); // 0.01
  });

  it("returns empty array for empty input", () => {
    expect(benjaminiHochberg([], 0.05)).toEqual([]);
  });

  it("handles single p-value below alpha", () => {
    expect(benjaminiHochberg([0.01], 0.05)).toEqual([true]);
  });

  it("handles single p-value above alpha", () => {
    expect(benjaminiHochberg([0.1], 0.05)).toEqual([false]);
  });
});
