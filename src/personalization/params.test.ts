import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  getEffectiveParams,
  type PersonalizedParams,
  personalizedParamsSchema,
} from "./params.ts";

describe("personalizedParamsSchema", () => {
  it("parses a fully populated params object", () => {
    const input: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: {
        ctlDays: 35,
        atlDays: 9,
        sampleCount: 120,
        correlation: 0.35,
      },
      readinessWeights: {
        hrv: 0.5,
        restingHr: 0.15,
        sleep: 0.2,
        loadBalance: 0.15,
        sampleCount: 90,
        correlation: 0.25,
      },
      sleepTarget: {
        minutes: 450,
        sampleCount: 30,
      },
      stressThresholds: {
        hrvThresholds: [-1.2, -0.8, -0.3],
        rhrThresholds: [1.2, 0.8, 0.3],
        sampleCount: 80,
      },
      trimpConstants: {
        genderFactor: 0.7,
        exponent: 1.8,
        sampleCount: 25,
        r2: 0.45,
      },
    };

    const result = personalizedParamsSchema.parse(input);
    expect(result).toEqual(input);
  });

  it("parses params with all null sub-objects", () => {
    const input = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trimpConstants: null,
    };

    const result = personalizedParamsSchema.parse(input);
    expect(result.ewma).toBeNull();
    expect(result.readinessWeights).toBeNull();
    expect(result.sleepTarget).toBeNull();
    expect(result.stressThresholds).toBeNull();
    expect(result.trimpConstants).toBeNull();
  });

  it("rejects invalid version", () => {
    const input = {
      version: 0,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trimpConstants: null,
    };

    expect(() => personalizedParamsSchema.parse(input)).toThrow();
  });

  it("rejects missing fittedAt", () => {
    const input = {
      version: 1,
      ewma: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trimpConstants: null,
    };

    expect(() => personalizedParamsSchema.parse(input)).toThrow();
  });

  it("rejects readiness weights that do not sum to 1", () => {
    const input = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: null,
      readinessWeights: {
        hrv: 0.5,
        restingHr: 0.3,
        sleep: 0.2,
        loadBalance: 0.2, // sums to 1.2
        sampleCount: 60,
        correlation: 0.2,
      },
      sleepTarget: null,
      stressThresholds: null,
      trimpConstants: null,
    };

    expect(() => personalizedParamsSchema.parse(input)).toThrow();
  });

  it("rejects readiness weights below minimum 0.05", () => {
    const input = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: null,
      readinessWeights: {
        hrv: 0.85,
        restingHr: 0.03, // below 0.05
        sleep: 0.07,
        loadBalance: 0.05,
        sampleCount: 60,
        correlation: 0.2,
      },
      sleepTarget: null,
      stressThresholds: null,
      trimpConstants: null,
    };

    expect(() => personalizedParamsSchema.parse(input)).toThrow();
  });

  it("rejects EWMA with CTL outside valid range", () => {
    const input = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: {
        ctlDays: 10, // below minimum 21
        atlDays: 7,
        sampleCount: 90,
        correlation: 0.3,
      },
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trimpConstants: null,
    };

    expect(() => personalizedParamsSchema.parse(input)).toThrow();
  });

  it("rejects stress thresholds not in descending order", () => {
    const input = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: {
        hrvThresholds: [-0.3, -0.8, -1.2], // should be descending magnitude (ascending value)
        rhrThresholds: [1.2, 0.8, 0.3],
        sampleCount: 60,
      },
      trimpConstants: null,
    };

    expect(() => personalizedParamsSchema.parse(input)).toThrow();
  });
});

describe("DEFAULT_PARAMS", () => {
  it("matches current hardcoded values", () => {
    expect(DEFAULT_PARAMS.ewma.ctlDays).toBe(42);
    expect(DEFAULT_PARAMS.ewma.atlDays).toBe(7);
    expect(DEFAULT_PARAMS.readinessWeights.hrv).toBe(0.4);
    expect(DEFAULT_PARAMS.readinessWeights.restingHr).toBe(0.2);
    expect(DEFAULT_PARAMS.readinessWeights.sleep).toBe(0.2);
    expect(DEFAULT_PARAMS.readinessWeights.loadBalance).toBe(0.2);
    expect(DEFAULT_PARAMS.sleepTarget.minutes).toBe(480);
    expect(DEFAULT_PARAMS.stressThresholds.hrvThresholds).toEqual([-1.5, -1.0, -0.5]);
    expect(DEFAULT_PARAMS.stressThresholds.rhrThresholds).toEqual([1.5, 1.0, 0.5]);
    expect(DEFAULT_PARAMS.trimpConstants.genderFactor).toBe(0.64);
    expect(DEFAULT_PARAMS.trimpConstants.exponent).toBe(1.92);
  });

  it("readiness weights sum to 1", () => {
    const w = DEFAULT_PARAMS.readinessWeights;
    expect(w.hrv + w.restingHr + w.sleep + w.loadBalance).toBeCloseTo(1.0);
  });
});

describe("getEffectiveParams", () => {
  it("returns defaults when stored params is null", () => {
    const result = getEffectiveParams(null);
    expect(result).toEqual(DEFAULT_PARAMS);
  });

  it("returns defaults when all sub-objects are null", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trimpConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(result).toEqual(DEFAULT_PARAMS);
  });

  it("uses personalized EWMA when available", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: {
        ctlDays: 35,
        atlDays: 9,
        sampleCount: 120,
        correlation: 0.35,
      },
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trimpConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.ewma.ctlDays).toBe(35);
    expect(result.ewma.atlDays).toBe(9);
    // Other params remain defaults
    expect(result.readinessWeights).toEqual(DEFAULT_PARAMS.readinessWeights);
    expect(result.sleepTarget).toEqual(DEFAULT_PARAMS.sleepTarget);
  });

  it("uses personalized readiness weights when available", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: null,
      readinessWeights: {
        hrv: 0.5,
        restingHr: 0.15,
        sleep: 0.2,
        loadBalance: 0.15,
        sampleCount: 90,
        correlation: 0.25,
      },
      sleepTarget: null,
      stressThresholds: null,
      trimpConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.readinessWeights.hrv).toBe(0.5);
    expect(result.readinessWeights.restingHr).toBe(0.15);
  });

  it("uses personalized sleep target when available", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: null,
      readinessWeights: null,
      sleepTarget: { minutes: 450, sampleCount: 30 },
      stressThresholds: null,
      trimpConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.sleepTarget.minutes).toBe(450);
  });

  it("merges multiple personalized params with defaults for the rest", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      ewma: {
        ctlDays: 49,
        atlDays: 11,
        sampleCount: 150,
        correlation: 0.4,
      },
      readinessWeights: null,
      sleepTarget: { minutes: 420, sampleCount: 20 },
      stressThresholds: {
        hrvThresholds: [-1.8, -1.2, -0.6],
        rhrThresholds: [1.8, 1.2, 0.6],
        sampleCount: 100,
      },
      trimpConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.ewma.ctlDays).toBe(49);
    expect(result.readinessWeights).toEqual(DEFAULT_PARAMS.readinessWeights);
    expect(result.sleepTarget.minutes).toBe(420);
    expect(result.stressThresholds.hrvThresholds).toEqual([-1.8, -1.2, -0.6]);
    expect(result.trimpConstants).toEqual(DEFAULT_PARAMS.trimpConstants);
  });
});
