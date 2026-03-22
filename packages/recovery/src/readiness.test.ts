import { describe, expect, it } from "vitest";
import { defaultReadinessWeights, ReadinessScore } from "./readiness.ts";

describe("ReadinessScore", () => {
  const weights = defaultReadinessWeights();

  it("returns 62 for all-neutral components at sigmoid center", () => {
    const score = new ReadinessScore(
      { hrvScore: 62, restingHrScore: 62, sleepScore: 62, respiratoryRateScore: 62 },
      weights,
    );
    expect(score.score).toBe(62);
  });

  it("returns 100 for perfect components", () => {
    const score = new ReadinessScore(
      { hrvScore: 100, restingHrScore: 100, sleepScore: 100, respiratoryRateScore: 100 },
      weights,
    );
    expect(score.score).toBe(100);
  });

  it("returns 0 for worst components", () => {
    const score = new ReadinessScore(
      { hrvScore: 0, restingHrScore: 0, sleepScore: 0, respiratoryRateScore: 0 },
      weights,
    );
    expect(score.score).toBe(0);
  });

  it("weighs HRV most heavily", () => {
    const highHrv = new ReadinessScore(
      { hrvScore: 100, restingHrScore: 62, sleepScore: 62, respiratoryRateScore: 62 },
      weights,
    );
    const highSleep = new ReadinessScore(
      { hrvScore: 62, restingHrScore: 62, sleepScore: 100, respiratoryRateScore: 62 },
      weights,
    );
    expect(highHrv.score).toBeGreaterThan(highSleep.score);
  });

  it("clamps result between 0 and 100", () => {
    const score = new ReadinessScore(
      { hrvScore: 200, restingHrScore: 200, sleepScore: 200, respiratoryRateScore: 200 },
      weights,
    );
    expect(score.score).toBeLessThanOrEqual(100);
  });
});
