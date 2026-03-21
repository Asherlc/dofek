import { describe, expect, it } from "vitest";
import {
  acwrToScore,
  computeReadinessScore,
  defaultReadinessWeights,
  type ReadinessComponents,
  zScoreToScore,
} from "./readiness.ts";

describe("zScoreToScore", () => {
  it("maps z=0 to 50", () => {
    expect(zScoreToScore(0)).toBe(50);
  });

  it("maps positive z-scores above 50", () => {
    expect(zScoreToScore(1)).toBe(65);
  });

  it("maps negative z-scores below 50", () => {
    expect(zScoreToScore(-1)).toBe(35);
  });

  it("clamps at 0", () => {
    expect(zScoreToScore(-10)).toBe(0);
  });

  it("clamps at 100", () => {
    expect(zScoreToScore(10)).toBe(100);
  });
});

describe("acwrToScore", () => {
  it("returns 100 for optimal ratio of 1.0", () => {
    expect(acwrToScore(1.0)).toBe(100);
  });

  it("returns 50 for null", () => {
    expect(acwrToScore(null)).toBe(50);
  });

  it("returns 0 for deviation >= 1.0", () => {
    expect(acwrToScore(2.0)).toBe(0);
    expect(acwrToScore(0.0)).toBe(0);
  });

  it("penalizes deviation from 1.0", () => {
    const score = acwrToScore(1.3);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });
});

describe("computeReadinessScore", () => {
  const weights = defaultReadinessWeights();

  it("returns 50 for all-neutral components", () => {
    const components: ReadinessComponents = {
      hrvScore: 50,
      restingHrScore: 50,
      sleepScore: 50,
      loadBalanceScore: 50,
    };
    expect(computeReadinessScore(components, weights)).toBe(50);
  });

  it("returns 100 for perfect components", () => {
    const components: ReadinessComponents = {
      hrvScore: 100,
      restingHrScore: 100,
      sleepScore: 100,
      loadBalanceScore: 100,
    };
    expect(computeReadinessScore(components, weights)).toBe(100);
  });

  it("returns 0 for worst components", () => {
    const components: ReadinessComponents = {
      hrvScore: 0,
      restingHrScore: 0,
      sleepScore: 0,
      loadBalanceScore: 0,
    };
    expect(computeReadinessScore(components, weights)).toBe(0);
  });

  it("weighs HRV most heavily", () => {
    const highHrv: ReadinessComponents = {
      hrvScore: 100,
      restingHrScore: 50,
      sleepScore: 50,
      loadBalanceScore: 50,
    };
    const highSleep: ReadinessComponents = {
      hrvScore: 50,
      restingHrScore: 50,
      sleepScore: 100,
      loadBalanceScore: 50,
    };
    expect(computeReadinessScore(highHrv, weights)).toBeGreaterThan(
      computeReadinessScore(highSleep, weights),
    );
  });

  it("clamps result between 0 and 100", () => {
    const result = computeReadinessScore(
      { hrvScore: 200, restingHrScore: 200, sleepScore: 200, loadBalanceScore: 200 },
      weights,
    );
    expect(result).toBeLessThanOrEqual(100);
  });
});
