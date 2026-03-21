import { describe, expect, it } from "vitest";
import { defaultReadinessWeights, ReadinessScore } from "./readiness.ts";

describe("ReadinessScore", () => {
  const weights = defaultReadinessWeights();

  describe("constructor + score", () => {
    it("returns 50 for all-neutral components", () => {
      const score = new ReadinessScore(
        { hrvScore: 50, restingHrScore: 50, sleepScore: 50, loadBalanceScore: 50 },
        weights,
      );
      expect(score.score).toBe(50);
    });

    it("returns 100 for perfect components", () => {
      const score = new ReadinessScore(
        { hrvScore: 100, restingHrScore: 100, sleepScore: 100, loadBalanceScore: 100 },
        weights,
      );
      expect(score.score).toBe(100);
    });

    it("returns 0 for worst components", () => {
      const score = new ReadinessScore(
        { hrvScore: 0, restingHrScore: 0, sleepScore: 0, loadBalanceScore: 0 },
        weights,
      );
      expect(score.score).toBe(0);
    });

    it("weighs HRV most heavily", () => {
      const highHrv = new ReadinessScore(
        { hrvScore: 100, restingHrScore: 50, sleepScore: 50, loadBalanceScore: 50 },
        weights,
      );
      const highSleep = new ReadinessScore(
        { hrvScore: 50, restingHrScore: 50, sleepScore: 100, loadBalanceScore: 50 },
        weights,
      );
      expect(highHrv.score).toBeGreaterThan(highSleep.score);
    });

    it("clamps result between 0 and 100", () => {
      const score = new ReadinessScore(
        { hrvScore: 200, restingHrScore: 200, sleepScore: 200, loadBalanceScore: 200 },
        weights,
      );
      expect(score.score).toBeLessThanOrEqual(100);
    });
  });

  describe("fromMetrics", () => {
    it("computes baseline score when HRV and RHR are at mean", () => {
      const score = ReadinessScore.fromMetrics(
        {
          hrv: 50,
          restingHr: 60,
          hrvMean: 50,
          hrvStddev: 10,
          rhrMean: 60,
          rhrStddev: 5,
          sleepEfficiency: 85,
          acwr: 1.0,
        },
        weights,
      );

      expect(score.components.hrvScore).toBe(50);
      expect(score.components.restingHrScore).toBe(50);
      expect(score.components.loadBalanceScore).toBe(100);
    });

    it("scores higher HRV above baseline positively", () => {
      const score = ReadinessScore.fromMetrics(
        {
          hrv: 60,
          restingHr: 60,
          hrvMean: 50,
          hrvStddev: 10,
          rhrMean: 60,
          rhrStddev: 5,
          sleepEfficiency: 85,
          acwr: 1.0,
        },
        weights,
      );

      // HRV z=1 → 65
      expect(score.components.hrvScore).toBe(65);
    });

    it("scores lower resting HR positively (inverted z-score)", () => {
      const score = ReadinessScore.fromMetrics(
        {
          hrv: 50,
          restingHr: 55,
          hrvMean: 50,
          hrvStddev: 10,
          rhrMean: 60,
          rhrStddev: 5,
          sleepEfficiency: 85,
          acwr: 1.0,
        },
        weights,
      );

      // RHR z = (55-60)/5 = -1, inverted → z=1 → 65
      expect(score.components.restingHrScore).toBe(65);
    });

    it("defaults to neutral (50) when all data is null", () => {
      const score = ReadinessScore.fromMetrics(
        {
          hrv: null,
          restingHr: null,
          hrvMean: null,
          hrvStddev: null,
          rhrMean: null,
          rhrStddev: null,
          sleepEfficiency: null,
          acwr: null,
        },
        weights,
      );

      expect(score.components.hrvScore).toBe(50);
      expect(score.components.restingHrScore).toBe(50);
      expect(score.components.sleepScore).toBe(50);
      expect(score.components.loadBalanceScore).toBe(50);
      expect(score.score).toBe(50);
    });

    it("clamps extreme z-scores to 100", () => {
      const score = ReadinessScore.fromMetrics(
        {
          hrv: 150,
          restingHr: 60,
          hrvMean: 50,
          hrvStddev: 10,
          rhrMean: 60,
          rhrStddev: 5,
          sleepEfficiency: 85,
          acwr: 1.0,
        },
        weights,
      );

      expect(score.components.hrvScore).toBe(100);
    });

    it("clamps extreme negative z-scores to 0", () => {
      const score = ReadinessScore.fromMetrics(
        {
          hrv: 0,
          restingHr: 60,
          hrvMean: 50,
          hrvStddev: 5,
          rhrMean: 60,
          rhrStddev: 5,
          sleepEfficiency: 85,
          acwr: 1.0,
        },
        weights,
      );

      expect(score.components.hrvScore).toBe(0);
    });

    it("penalizes ACWR deviation from 1.0 in either direction", () => {
      const optimal = ReadinessScore.fromMetrics(
        {
          hrv: 50,
          restingHr: 60,
          hrvMean: 50,
          hrvStddev: 10,
          rhrMean: 60,
          rhrStddev: 5,
          sleepEfficiency: 85,
          acwr: 1.0,
        },
        weights,
      );

      const overloaded = ReadinessScore.fromMetrics(
        {
          hrv: 50,
          restingHr: 60,
          hrvMean: 50,
          hrvStddev: 10,
          rhrMean: 60,
          rhrStddev: 5,
          sleepEfficiency: 85,
          acwr: 1.5,
        },
        weights,
      );

      const underloaded = ReadinessScore.fromMetrics(
        {
          hrv: 50,
          restingHr: 60,
          hrvMean: 50,
          hrvStddev: 10,
          rhrMean: 60,
          rhrStddev: 5,
          sleepEfficiency: 85,
          acwr: 0.5,
        },
        weights,
      );

      expect(optimal.components.loadBalanceScore).toBe(100);
      expect(overloaded.components.loadBalanceScore).toBe(50);
      expect(underloaded.components.loadBalanceScore).toBe(50);
    });

    it("returns 0 for ACWR deviation >= 1.0", () => {
      const score = ReadinessScore.fromMetrics(
        {
          hrv: 50,
          restingHr: 60,
          hrvMean: 50,
          hrvStddev: 10,
          rhrMean: 60,
          rhrStddev: 5,
          sleepEfficiency: 85,
          acwr: 2.0,
        },
        weights,
      );

      expect(score.components.loadBalanceScore).toBe(0);
    });

    it("handles zero stddev gracefully (defaults to neutral)", () => {
      const score = ReadinessScore.fromMetrics(
        {
          hrv: 50,
          restingHr: 60,
          hrvMean: 50,
          hrvStddev: 0,
          rhrMean: 60,
          rhrStddev: 0,
          sleepEfficiency: 85,
          acwr: 1.0,
        },
        weights,
      );

      expect(score.components.hrvScore).toBe(50);
      expect(score.components.restingHrScore).toBe(50);
    });

    it("uses sleep efficiency directly as sleep score", () => {
      const score = ReadinessScore.fromMetrics(
        {
          hrv: 50,
          restingHr: 60,
          hrvMean: 50,
          hrvStddev: 10,
          rhrMean: 60,
          rhrStddev: 5,
          sleepEfficiency: 92,
          acwr: 1.0,
        },
        weights,
      );

      expect(score.components.sleepScore).toBe(92);
    });
  });
});
