import { describe, expect, it } from "vitest";
import {
  computeReadinessScore,
  defaultReadinessWeights,
  type ReadinessComponents,
} from "./readiness.ts";

describe("computeReadinessScore", () => {
  const weights = defaultReadinessWeights();

  it("returns 62 for all-neutral components at sigmoid center", () => {
    const components: ReadinessComponents = {
      hrvScore: 62,
      restingHrScore: 62,
      sleepScore: 62,
      respiratoryRateScore: 62,
    };
    expect(computeReadinessScore(components, weights)).toBe(62);
  });

  it("returns 100 for perfect components", () => {
    const components: ReadinessComponents = {
      hrvScore: 100,
      restingHrScore: 100,
      sleepScore: 100,
      respiratoryRateScore: 100,
    };
    expect(computeReadinessScore(components, weights)).toBe(100);
  });

  it("returns 0 for worst components", () => {
    const components: ReadinessComponents = {
      hrvScore: 0,
      restingHrScore: 0,
      sleepScore: 0,
      respiratoryRateScore: 0,
    };
    expect(computeReadinessScore(components, weights)).toBe(0);
  });

  it("weighs HRV most heavily", () => {
    const highHrv: ReadinessComponents = {
      hrvScore: 100,
      restingHrScore: 62,
      sleepScore: 62,
      respiratoryRateScore: 62,
    };
    const highSleep: ReadinessComponents = {
      hrvScore: 62,
      restingHrScore: 62,
      sleepScore: 100,
      respiratoryRateScore: 62,
    };
    expect(computeReadinessScore(highHrv, weights)).toBeGreaterThan(
      computeReadinessScore(highSleep, weights),
    );
  });

  it("clamps result between 0 and 100", () => {
    const result = computeReadinessScore(
      { hrvScore: 200, restingHrScore: 200, sleepScore: 200, respiratoryRateScore: 200 },
      weights,
    );
    expect(result).toBeLessThanOrEqual(100);
  });
});
