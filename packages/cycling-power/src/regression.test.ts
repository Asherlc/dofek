import { describe, expect, it } from "vitest";
import { linearRegression } from "./regression.ts";

describe("linearRegression", () => {
  it.each([
    { xs: [1, 2], ys: [3] },
    { xs: [1], ys: [3, 4] },
    { xs: [], ys: [3] },
    { xs: [1, Number.NaN], ys: [3, 4] },
    { xs: [1, Number.POSITIVE_INFINITY], ys: [3, 4] },
    { xs: [1, 2], ys: [3, Number.NaN] },
    { xs: [1, 2], ys: [3, Number.NEGATIVE_INFINITY] },
    { xs: Array<number>(2), ys: [3, 4] },
  ])("rejects unpaired or non-finite regression inputs %j", ({ xs, ys }) => {
    expect(() => linearRegression(xs, ys)).toThrow(RangeError);
  });

  it("preserves the empty-input result", () => {
    expect(linearRegression([], [])).toEqual({ slope: 0, intercept: 0, r2: 0 });
  });

  it("fits a perfect line", () => {
    const { slope, intercept, r2 } = linearRegression([1, 2, 3], [2, 4, 6]);
    expect(slope).toBeCloseTo(2);
    expect(intercept).toBeCloseTo(0);
    expect(r2).toBeCloseTo(1);
  });

  it("fits a line with nonzero intercept", () => {
    const { slope, intercept, r2 } = linearRegression([1, 2, 3, 4], [8, 11, 14, 17]);
    expect(slope).toBeCloseTo(3);
    expect(intercept).toBeCloseTo(5);
    expect(r2).toBeCloseTo(1);
  });

  it("returns zero slope and intercept for degenerate input", () => {
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
    const { slope, intercept } = linearRegression([1, 2, 3], [8, 6, 4]);
    expect(slope).toBeCloseTo(-2);
    expect(intercept).toBeCloseTo(10);
  });
});
