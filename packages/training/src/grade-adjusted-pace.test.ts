import { describe, expect, it } from "vitest";
import { computeGradeAdjustedPace, minettiCostFactor } from "./grade-adjusted-pace.ts";

describe("minettiCostFactor", () => {
  it("returns 1 on flat terrain (0% grade)", () => {
    expect(minettiCostFactor(0)).toBe(1);
  });

  it("returns > 1 for uphill grades (costs more energy)", () => {
    expect(minettiCostFactor(0.05)).toBeGreaterThan(1);
    expect(minettiCostFactor(0.1)).toBeGreaterThan(1);
  });

  it("scales linearly with positive grade (1 + grade * 3.5)", () => {
    expect(minettiCostFactor(0.1)).toBeCloseTo(1.35, 5);
    expect(minettiCostFactor(0.2)).toBeCloseTo(1.7, 5);
  });

  it("returns < 1 for moderate downhill (easier than flat)", () => {
    expect(minettiCostFactor(-0.05)).toBeLessThan(1);
  });

  it("floors at 0.5 for steep downhill", () => {
    // At grade -0.30, formula gives 1 - 0.30 * 1.8 = 0.46, floored to 0.5
    expect(minettiCostFactor(-0.3)).toBe(0.5);
    expect(minettiCostFactor(-0.5)).toBe(0.5);
  });

  it("computes correct value at the floor boundary", () => {
    // Floor kicks in when 1 - |grade| * 1.8 < 0.5, i.e. |grade| > 5/18 ≈ 0.2778
    // At exactly grade = -5/18, cost = 0.5
    expect(minettiCostFactor(-5 / 18)).toBeCloseTo(0.5, 5);
    // Just above the boundary
    expect(minettiCostFactor(-0.27)).toBeGreaterThan(0.5);
  });
});

describe("computeGradeAdjustedPace", () => {
  it("returns the same pace on flat terrain", () => {
    const result = computeGradeAdjustedPace(6.0, 0);
    expect(result).toBeCloseTo(6.0, 5);
  });

  it("returns a faster (lower) pace for uphill activities", () => {
    // Uphill: actual pace is slow but grade-adjusted should be faster
    const result = computeGradeAdjustedPace(8.0, 0.1);
    expect(result).toBeLessThan(8.0);
    // 8.0 / 1.35 ≈ 5.93
    expect(result).toBeCloseTo(8.0 / 1.35, 2);
  });

  it("returns a slower (higher) pace for downhill activities", () => {
    // Downhill: actual pace is fast but grade-adjusted should be slower
    const result = computeGradeAdjustedPace(5.0, -0.05);
    expect(result).toBeGreaterThan(5.0);
    // 5.0 / (1 - 0.05 * 1.8) = 5.0 / 0.91 ≈ 5.49
    expect(result).toBeCloseTo(5.0 / 0.91, 2);
  });

  it("returns 0 when actual pace is 0", () => {
    expect(computeGradeAdjustedPace(0, 0.1)).toBe(0);
  });
});
