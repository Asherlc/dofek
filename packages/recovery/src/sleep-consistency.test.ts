import { describe, expect, it } from "vitest";
import { computeSleepConsistencyScore } from "./sleep-consistency.ts";

describe("computeSleepConsistencyScore", () => {
  it("returns 100 for very consistent schedule (< 0.5hr stddev)", () => {
    const score = computeSleepConsistencyScore(0.3, 0.3);
    expect(score).toBe(100);
  });

  it("returns 0 for very inconsistent schedule (> 1.5hr stddev)", () => {
    const score = computeSleepConsistencyScore(2.0, 2.0);
    expect(score).toBe(0);
  });

  it("returns intermediate score for moderate consistency", () => {
    const score = computeSleepConsistencyScore(0.8, 0.8);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it("uses the average of bed and wake stddev", () => {
    // 0.5 avg = 100 (perfect threshold)
    const score = computeSleepConsistencyScore(0.3, 0.7);
    expect(score).toBe(100);
  });

  it("returns null when not enough data", () => {
    const score = computeSleepConsistencyScore(null, null);
    expect(score).toBeNull();
  });

  it("clamps between 0 and 100", () => {
    expect(computeSleepConsistencyScore(0.0, 0.0)).toBeLessThanOrEqual(100);
    expect(computeSleepConsistencyScore(10.0, 10.0)).toBeGreaterThanOrEqual(0);
  });
});
