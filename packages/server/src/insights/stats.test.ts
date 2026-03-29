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

  it("computes correct stats for negative numbers", () => {
    const result = describe([-5, -3, -1, 0, 2]);
    expect(result.mean).toBeCloseTo(-1.4, 10);
    expect(result.median).toBe(-1);
    expect(result.n).toBe(5);
    expect(result.stddev).toBeGreaterThan(0);
  });

  it("computes correct stats for large array (>100 values)", () => {
    const values = Array.from({ length: 200 }, (_, index) => index + 1);
    const result = describe(values);
    expect(result.mean).toBeCloseTo(100.5, 10);
    expect(result.median).toBeCloseTo(100.5, 10);
    expect(result.n).toBe(200);
    expect(result.stddev).toBeGreaterThan(0);
  });

  it("returns exact p25 and p75 for known quartile values", () => {
    const result = describe([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.p25).toBeCloseTo(2.75, 5);
    expect(result.p75).toBeCloseTo(6.25, 5);
    expect(result.mean).toBeCloseTo(4.5, 10);
    expect(result.n).toBe(8);
  });

  it("returns correct stddev for two different values", () => {
    const result = describe([0, 10]);
    expect(result.mean).toBe(5);
    expect(result.median).toBe(5);
    expect(result.stddev).toBeCloseTo(5, 3);
    expect(result.n).toBe(2);
  });

  it("sorting comparator produces ascending order (kills a-b vs b-a mutant)", () => {
    const result = describe([100, 1, 50]);
    expect(result.median).toBe(50);
  });

  it("returns p25 and p75 equal to value for single element", () => {
    const result = describe([42]);
    expect(result.p25).toBe(42);
    expect(result.p75).toBe(42);
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

  it("returns neutral result when first group has exactly 1 element", () => {
    const result = welchTTest([5], [1, 2, 3]);
    expect(result).toEqual({ t: 0, pValue: 1, df: 0 });
  });

  it("returns neutral result when second group has exactly 1 element", () => {
    const result = welchTTest([1, 2, 3], [5]);
    expect(result).toEqual({ t: 0, pValue: 1, df: 0 });
  });

  it("works with both groups of size 2 (minimal valid input)", () => {
    const result = welchTTest([1, 2], [10, 11]);
    expect(result.t).toBeLessThan(0);
    expect(result.pValue).toBeGreaterThan(0);
    expect(result.pValue).toBeLessThan(1);
    expect(result.df).toBeGreaterThan(0);
  });

  it("t-statistic is positive when group a has higher mean", () => {
    const result = welchTTest([10, 12], [1, 3]);
    expect(result.t).toBeGreaterThan(0);
  });

  it("t-statistic is negative when group a has lower mean", () => {
    const result = welchTTest([1, 3], [10, 12]);
    expect(result.t).toBeLessThan(0);
  });

  it("handles groups with very different variances", () => {
    const groupA = [50, 50, 50, 50, 50];
    const groupB = [0, 25, 50, 75, 100];
    const result = welchTTest(groupA, groupB);
    expect(result.t).toBeCloseTo(0, 5);
    expect(result.pValue).toBeCloseTo(1, 1);
  });

  it("computes known t-statistic for simple inputs", () => {
    const result = welchTTest([0, 4], [10, 14]);
    expect(result.t).toBeCloseTo(-3.536, 2);
    expect(result.pValue).toBeLessThan(0.1);
  });

  it("empty groups return neutral result", () => {
    expect(welchTTest([], [1, 2, 3])).toEqual({ t: 0, pValue: 1, df: 0 });
    expect(welchTTest([1, 2, 3], [])).toEqual({ t: 0, pValue: 1, df: 0 });
    expect(welchTTest([], [])).toEqual({ t: 0, pValue: 1, df: 0 });
  });

  it("pValue is always between 0 and 1 for valid groups", () => {
    const result = welchTTest([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
    expect(result.pValue).toBeGreaterThanOrEqual(0);
    expect(result.pValue).toBeLessThanOrEqual(1);
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

  it("returns 0 when both groups are constant but different (zero pooled stddev)", () => {
    expect(cohensD([3, 3, 3], [7, 7, 7])).toBe(0);
    expect(cohensD([7, 7, 7], [3, 3, 3])).toBe(0);
  });

  it("returns 0 for both groups with < 2 elements", () => {
    expect(cohensD([1], [2])).toBe(0);
    expect(cohensD([], [])).toBe(0);
    expect(cohensD([], [1, 2])).toBe(0);
  });

  it("sign reflects direction: swapping groups negates the result", () => {
    const positiveEffect = cohensD([10, 12, 14], [1, 3, 5]);
    const negativeEffect = cohensD([1, 3, 5], [10, 12, 14]);
    expect(positiveEffect).toBeGreaterThan(0);
    expect(negativeEffect).toBeLessThan(0);
    expect(positiveEffect).toBeCloseTo(-negativeEffect, 10);
  });

  it("computes known medium effect size", () => {
    const effectSize = cohensD([0, 2], [1, 3]);
    expect(effectSize).toBeCloseTo(-Math.SQRT1_2, 2);
  });

  it("works with minimal valid groups of size 2", () => {
    const effectSize = cohensD([1, 3], [5, 7]);
    expect(effectSize).toBeCloseTo(-2.828, 2);
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

  it("returns perfect negative correlation for exactly 5 values (boundary)", () => {
    const result = spearmanCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]);
    expect(result.rho).toBeCloseTo(-1.0, 5);
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.n).toBe(5);
  });

  it("returns neutral for exactly 4 values (boundary: n < 5)", () => {
    const result = spearmanCorrelation([1, 2, 3, 4], [4, 3, 2, 1]);
    expect(result.rho).toBe(0);
    expect(result.pValue).toBe(1);
    expect(result.n).toBe(4);
  });

  it("works at exact boundary of 5 values with perfect positive correlation", () => {
    const result = spearmanCorrelation([10, 20, 30, 40, 50], [1, 2, 3, 4, 5]);
    expect(result.rho).toBeCloseTo(1.0, 5);
    expect(result.n).toBe(5);
  });

  it("handles tied ranks correctly", () => {
    const result = spearmanCorrelation([1, 1, 2, 3, 4], [10, 20, 30, 40, 50]);
    expect(result.rho).toBeGreaterThan(0);
    expect(result.rho).toBeLessThanOrEqual(1);
    expect(result.n).toBe(5);
  });

  it("verifies n field matches input length", () => {
    const result = spearmanCorrelation([1, 2, 3, 4, 5, 6, 7], [7, 6, 5, 4, 3, 2, 1]);
    expect(result.n).toBe(7);
  });

  it("returns neutral for empty arrays", () => {
    const result = spearmanCorrelation([], []);
    expect(result.rho).toBe(0);
    expect(result.pValue).toBe(1);
    expect(result.n).toBe(0);
  });

  it("returns neutral for n=1", () => {
    const result = spearmanCorrelation([5], [10]);
    expect(result.rho).toBe(0);
    expect(result.pValue).toBe(1);
    expect(result.n).toBe(1);
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

  it("single p-value exactly at alpha threshold passes", () => {
    expect(benjaminiHochberg([0.05], 0.05)).toEqual([true]);
  });

  it("alpha=1.0 makes all p-values pass", () => {
    const result = benjaminiHochberg([0.1, 0.5, 0.9, 0.99], 1.0);
    expect(result).toEqual([true, true, true, true]);
  });

  it("alpha=0 makes no non-zero p-values pass", () => {
    const result = benjaminiHochberg([0.01, 0.05, 0.1, 0.5], 0);
    expect(result).toEqual([false, false, false, false]);
  });

  it("all p-values below their BH threshold", () => {
    const result = benjaminiHochberg([0.001, 0.002, 0.003, 0.004], 0.05);
    expect(result).toEqual([true, true, true, true]);
  });

  it("preserves original order in results", () => {
    const result = benjaminiHochberg([0.5, 0.001, 0.3, 0.002], 0.05);
    expect(result).toEqual([false, true, false, true]);
  });

  it("handles duplicate p-values correctly", () => {
    const result = benjaminiHochberg([0.01, 0.01, 0.01], 0.05);
    expect(result).toEqual([true, true, true]);
  });

  it("result length always matches input length", () => {
    expect(benjaminiHochberg([0.1], 0.05).length).toBe(1);
    expect(benjaminiHochberg([0.1, 0.2], 0.05).length).toBe(2);
    expect(benjaminiHochberg([0.1, 0.2, 0.3, 0.4, 0.5], 0.05).length).toBe(5);
  });
});
