import { describe, expect, it } from "vitest";
import { normalizePercentages } from "./SleepBar";

describe("normalizePercentages", () => {
  it("corrects percentages that would naively round to 101", () => {
    // 96.5% light + 3.5% awake → naive Math.round gives 97 + 4 = 101
    const result = normalizePercentages([0, 0, 96.5, 3.5]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
    // Largest value (light) absorbs the -1 adjustment
    expect(result).toEqual([0, 0, 96, 4]);
  });

  it("corrects percentages that would naively round to 99", () => {
    const result = normalizePercentages([15.3, 20.3, 50.1, 14.3]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("handles normal percentages that sum to 100 cleanly", () => {
    const result = normalizePercentages([15, 20, 55, 10]);
    expect(result).toEqual([15, 20, 55, 10]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("handles all zeros", () => {
    const result = normalizePercentages([0, 0, 0, 0]);
    expect(result).toEqual([0, 0, 0, 0]);
  });

  it("handles a single non-zero stage", () => {
    const result = normalizePercentages([0, 0, 95.2, 4.8]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
    expect(result).toEqual([0, 0, 95, 5]);
  });

  it("distributes rounding correction to the largest stage", () => {
    // deep: 12.7, rem: 18.2, light: 55.8, awake: 13.3
    // Rounded: 13 + 18 + 56 + 13 = 100 (no correction needed)
    const result = normalizePercentages([12.7, 18.2, 55.8, 13.3]);
    expect(result).toEqual([13, 18, 56, 13]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("scales raw percentages that sum to less than 100", () => {
    // Stages cover only 90% of in-bed time (10% untracked)
    // Should scale to sum to 100 for display
    const result = normalizePercentages([9, 13.5, 49.5, 18]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
    // 9/90 * 100 = 10, 13.5/90 * 100 = 15, 49.5/90 * 100 = 55, 18/90 * 100 = 20
    expect(result).toEqual([10, 15, 55, 20]);
  });

  it("scales raw percentages that sum to more than 100", () => {
    // Due to cross-source double-counting, stages might sum to > 100
    const result = normalizePercentages([10, 15, 100, 5]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
  });
});
