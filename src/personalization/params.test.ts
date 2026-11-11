import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  getEffectiveParams,
  type PersonalizedParams,
  personalizedParamsSchema,
} from "./params.ts";

/** Helper to build a valid base params object with all nulls */
function baseParams(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    version: 1,
    fittedAt: "2026-03-18T12:00:00Z",
    exponentialMovingAverage: null,
    stressThresholds: null,
    ...overrides,
  };
}

describe("personalizedParamsSchema", () => {
  it("parses a fully populated params object", () => {
    const input: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: {
        chronicTrainingLoadDays: 35,
        acuteTrainingLoadDays: 9,
        sampleCount: 120,
        correlation: 0.35,
      },
      stressThresholds: {
        hrvThresholds: [-1.2, -0.8, -0.3],
        rhrThresholds: [1.2, 0.8, 0.3],
        sampleCount: 80,
      },
    };

    const result = personalizedParamsSchema.parse(input);
    expect(result).toEqual(input);
  });

  it("parses params with all null sub-objects", () => {
    const input = baseParams();

    const result = personalizedParamsSchema.parse(input);
    expect(result.exponentialMovingAverage).toBeNull();
    expect(result.stressThresholds).toBeNull();
  });

  it("keeps legacy params without per-model successful-fit timestamps valid", () => {
    const result = personalizedParamsSchema.parse(baseParams());

    expect(result.successfulFitAt).toBeUndefined();
  });

  it("parses per-model successful-fit timestamps", () => {
    const successfulFitAt = {
      exponentialMovingAverage: "2026-03-18T12:00:00.000Z",
      stressThresholds: null,
    };

    const result = personalizedParamsSchema.parse(baseParams({ version: 2, successfulFitAt }));

    expect(result.successfulFitAt).toEqual(successfulFitAt);
  });

  it("rejects invalid per-model successful-fit timestamps", () => {
    expect(() =>
      personalizedParamsSchema.parse(
        baseParams({
          version: 2,
          successfulFitAt: {
            exponentialMovingAverage: "not-a-timestamp",
            stressThresholds: null,
          },
        }),
      ),
    ).toThrow();
  });

  describe("version field", () => {
    it("rejects version 0 (must be >= 1)", () => {
      expect(() => personalizedParamsSchema.parse(baseParams({ version: 0 }))).toThrow();
    });

    it("rejects negative version", () => {
      expect(() => personalizedParamsSchema.parse(baseParams({ version: -1 }))).toThrow();
    });

    it("rejects non-integer version", () => {
      expect(() => personalizedParamsSchema.parse(baseParams({ version: 1.5 }))).toThrow();
    });

    it("accepts version 1 (minimum)", () => {
      const result = personalizedParamsSchema.parse(baseParams({ version: 1 }));
      expect(result.version).toBe(1);
    });

    it("accepts version 2 (above minimum)", () => {
      const result = personalizedParamsSchema.parse(baseParams({ version: 2 }));
      expect(result.version).toBe(2);
    });
  });

  it("rejects missing fittedAt", () => {
    const input = {
      version: 1,
      exponentialMovingAverage: null,
      stressThresholds: null,
    };
    expect(() => personalizedParamsSchema.parse(input)).toThrow();
  });

  describe("exponentialMovingAverage sub-schema", () => {
    it("rejects chronicTrainingLoadDays below minimum 21", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            exponentialMovingAverage: {
              chronicTrainingLoadDays: 20,
              acuteTrainingLoadDays: 7,
              sampleCount: 90,
              correlation: 0.3,
            },
          }),
        ),
      ).toThrow();
    });

    it("accepts chronicTrainingLoadDays at minimum 21", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          exponentialMovingAverage: {
            chronicTrainingLoadDays: 21,
            acuteTrainingLoadDays: 7,
            sampleCount: 90,
            correlation: 0.3,
          },
        }),
      );
      expect(result.exponentialMovingAverage?.chronicTrainingLoadDays).toBe(21);
    });

    it("accepts chronicTrainingLoadDays at maximum 63", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          exponentialMovingAverage: {
            chronicTrainingLoadDays: 63,
            acuteTrainingLoadDays: 7,
            sampleCount: 90,
            correlation: 0.3,
          },
        }),
      );
      expect(result.exponentialMovingAverage?.chronicTrainingLoadDays).toBe(63);
    });

    it("rejects chronicTrainingLoadDays above maximum 63", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            exponentialMovingAverage: {
              chronicTrainingLoadDays: 64,
              acuteTrainingLoadDays: 7,
              sampleCount: 90,
              correlation: 0.3,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects non-integer chronicTrainingLoadDays", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            exponentialMovingAverage: {
              chronicTrainingLoadDays: 35.5,
              acuteTrainingLoadDays: 7,
              sampleCount: 90,
              correlation: 0.3,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects acuteTrainingLoadDays below minimum 5", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            exponentialMovingAverage: {
              chronicTrainingLoadDays: 42,
              acuteTrainingLoadDays: 4,
              sampleCount: 90,
              correlation: 0.3,
            },
          }),
        ),
      ).toThrow();
    });

    it("accepts acuteTrainingLoadDays at minimum 5", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          exponentialMovingAverage: {
            chronicTrainingLoadDays: 42,
            acuteTrainingLoadDays: 5,
            sampleCount: 90,
            correlation: 0.3,
          },
        }),
      );
      expect(result.exponentialMovingAverage?.acuteTrainingLoadDays).toBe(5);
    });

    it("accepts acuteTrainingLoadDays at maximum 14", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          exponentialMovingAverage: {
            chronicTrainingLoadDays: 42,
            acuteTrainingLoadDays: 14,
            sampleCount: 90,
            correlation: 0.3,
          },
        }),
      );
      expect(result.exponentialMovingAverage?.acuteTrainingLoadDays).toBe(14);
    });

    it("rejects acuteTrainingLoadDays above maximum 14", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            exponentialMovingAverage: {
              chronicTrainingLoadDays: 42,
              acuteTrainingLoadDays: 15,
              sampleCount: 90,
              correlation: 0.3,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects non-integer acuteTrainingLoadDays", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            exponentialMovingAverage: {
              chronicTrainingLoadDays: 42,
              acuteTrainingLoadDays: 7.5,
              sampleCount: 90,
              correlation: 0.3,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects negative sampleCount", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            exponentialMovingAverage: {
              chronicTrainingLoadDays: 42,
              acuteTrainingLoadDays: 7,
              sampleCount: -1,
              correlation: 0.3,
            },
          }),
        ),
      ).toThrow();
    });

    it("accepts sampleCount of 0", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          exponentialMovingAverage: {
            chronicTrainingLoadDays: 42,
            acuteTrainingLoadDays: 7,
            sampleCount: 0,
            correlation: 0.3,
          },
        }),
      );
      expect(result.exponentialMovingAverage?.sampleCount).toBe(0);
    });

    it("rejects non-integer sampleCount", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            exponentialMovingAverage: {
              chronicTrainingLoadDays: 42,
              acuteTrainingLoadDays: 7,
              sampleCount: 1.5,
              correlation: 0.3,
            },
          }),
        ),
      ).toThrow();
    });
  });

  describe("stress thresholds sub-schema", () => {
    it("rejects HRV thresholds not in ascending order", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            stressThresholds: {
              hrvThresholds: [-0.3, -0.8, -1.2],
              rhrThresholds: [1.2, 0.8, 0.3],
              sampleCount: 60,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects equal HRV threshold values (h0 == h1)", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            stressThresholds: {
              hrvThresholds: [-1.0, -1.0, -0.5],
              rhrThresholds: [1.2, 0.8, 0.3],
              sampleCount: 60,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects equal HRV threshold values (h1 == h2)", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            stressThresholds: {
              hrvThresholds: [-1.5, -0.5, -0.5],
              rhrThresholds: [1.2, 0.8, 0.3],
              sampleCount: 60,
            },
          }),
        ),
      ).toThrow();
    });

    it("accepts HRV thresholds in strictly ascending order", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          stressThresholds: {
            hrvThresholds: [-2.0, -1.0, -0.1],
            rhrThresholds: [2.0, 1.0, 0.1],
            sampleCount: 60,
          },
        }),
      );
      expect(result.stressThresholds?.hrvThresholds).toEqual([-2.0, -1.0, -0.1]);
    });

    it("accepts HRV thresholds with minimal gap (strict, not <=)", () => {
      // h0 < h1 < h2 with tiny gaps to prove strict inequality
      const result = personalizedParamsSchema.parse(
        baseParams({
          stressThresholds: {
            hrvThresholds: [-1.0, -0.999, -0.998],
            rhrThresholds: [1.0, 0.999, 0.998],
            sampleCount: 60,
          },
        }),
      );
      expect(result.stressThresholds?.hrvThresholds).toEqual([-1.0, -0.999, -0.998]);
    });

    it("accepts RHR thresholds with minimal gap (strict, not >=)", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          stressThresholds: {
            hrvThresholds: [-1.0, -0.999, -0.998],
            rhrThresholds: [1.0, 0.999, 0.998],
            sampleCount: 60,
          },
        }),
      );
      expect(result.stressThresholds?.rhrThresholds).toEqual([1.0, 0.999, 0.998]);
    });

    it("rejects RHR thresholds not in descending order", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            stressThresholds: {
              hrvThresholds: [-1.5, -1.0, -0.5],
              rhrThresholds: [0.3, 0.8, 1.2],
              sampleCount: 60,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects equal RHR threshold values (r0 == r1)", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            stressThresholds: {
              hrvThresholds: [-1.5, -1.0, -0.5],
              rhrThresholds: [1.0, 1.0, 0.3],
              sampleCount: 60,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects equal RHR threshold values (r1 == r2)", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            stressThresholds: {
              hrvThresholds: [-1.5, -1.0, -0.5],
              rhrThresholds: [1.2, 0.5, 0.5],
              sampleCount: 60,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects wrong tuple length for hrvThresholds", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            stressThresholds: {
              hrvThresholds: [-1.5, -1.0],
              rhrThresholds: [1.2, 0.8, 0.3],
              sampleCount: 60,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects wrong tuple length for rhrThresholds", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            stressThresholds: {
              hrvThresholds: [-1.5, -1.0, -0.5],
              rhrThresholds: [1.2, 0.8],
              sampleCount: 60,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects negative sampleCount", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            stressThresholds: {
              hrvThresholds: [-1.5, -1.0, -0.5],
              rhrThresholds: [1.2, 0.8, 0.3],
              sampleCount: -1,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects non-integer sampleCount", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            stressThresholds: {
              hrvThresholds: [-1.5, -1.0, -0.5],
              rhrThresholds: [1.2, 0.8, 0.3],
              sampleCount: 60.5,
            },
          }),
        ),
      ).toThrow();
    });
  });
});

describe("DEFAULT_PARAMS", () => {
  it("matches current hardcoded values", () => {
    expect(DEFAULT_PARAMS.exponentialMovingAverage.chronicTrainingLoadDays).toBe(42);
    expect(DEFAULT_PARAMS.exponentialMovingAverage.acuteTrainingLoadDays).toBe(7);
    expect(DEFAULT_PARAMS.stressThresholds.hrvThresholds).toEqual([-1.5, -1.0, -0.5]);
    expect(DEFAULT_PARAMS.stressThresholds.rhrThresholds).toEqual([1.5, 1.0, 0.5]);
  });

  it("stress thresholds are in correct order", () => {
    const [h0, h1, h2] = DEFAULT_PARAMS.stressThresholds.hrvThresholds;
    expect(h0).toBeLessThan(h1);
    expect(h1).toBeLessThan(h2);

    const [r0, r1, r2] = DEFAULT_PARAMS.stressThresholds.rhrThresholds;
    expect(r0).toBeGreaterThan(r1);
    expect(r1).toBeGreaterThan(r2);
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
      exponentialMovingAverage: null,
      stressThresholds: null,
    };

    const result = getEffectiveParams(stored);
    expect(result).toEqual(DEFAULT_PARAMS);
  });

  it("uses personalized exponential moving average when available and defaults for the rest", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: {
        chronicTrainingLoadDays: 35,
        acuteTrainingLoadDays: 9,
        sampleCount: 120,
        correlation: 0.35,
      },
      stressThresholds: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.exponentialMovingAverage.chronicTrainingLoadDays).toBe(35);
    expect(result.exponentialMovingAverage.acuteTrainingLoadDays).toBe(9);
    expect(result.stressThresholds).toEqual(DEFAULT_PARAMS.stressThresholds);
  });

  it("uses personalized stress thresholds when available", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      stressThresholds: {
        hrvThresholds: [-2.0, -1.3, -0.7],
        rhrThresholds: [2.0, 1.3, 0.7],
        sampleCount: 100,
      },
    };

    const result = getEffectiveParams(stored);
    expect(result.stressThresholds.hrvThresholds).toEqual([-2.0, -1.3, -0.7]);
    expect(result.stressThresholds.rhrThresholds).toEqual([2.0, 1.3, 0.7]);
  });

  it("merges multiple personalized params with defaults for the rest", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: {
        chronicTrainingLoadDays: 49,
        acuteTrainingLoadDays: 11,
        sampleCount: 150,
        correlation: 0.4,
      },
      stressThresholds: {
        hrvThresholds: [-1.8, -1.2, -0.6],
        rhrThresholds: [1.8, 1.2, 0.6],
        sampleCount: 100,
      },
    };

    const result = getEffectiveParams(stored);
    expect(result.exponentialMovingAverage.chronicTrainingLoadDays).toBe(49);
    expect(result.exponentialMovingAverage.acuteTrainingLoadDays).toBe(11);
    expect(result.stressThresholds.hrvThresholds).toEqual([-1.8, -1.2, -0.6]);
    expect(result.stressThresholds.rhrThresholds).toEqual([1.8, 1.2, 0.6]);
  });

  it("strips sampleCount and correlation from effective exponentialMovingAverage params", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: {
        chronicTrainingLoadDays: 35,
        acuteTrainingLoadDays: 9,
        sampleCount: 120,
        correlation: 0.35,
      },
      stressThresholds: null,
    };

    const result = getEffectiveParams(stored);
    // Should only contain chronicTrainingLoadDays and acuteTrainingLoadDays, not sampleCount/correlation
    expect(Object.keys(result.exponentialMovingAverage).sort()).toEqual([
      "acuteTrainingLoadDays",
      "chronicTrainingLoadDays",
    ]);
  });

  it("strips sampleCount from effective stress thresholds", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      stressThresholds: {
        hrvThresholds: [-1.5, -1.0, -0.5],
        rhrThresholds: [1.5, 1.0, 0.5],
        sampleCount: 100,
      },
    };

    const result = getEffectiveParams(stored);
    expect(Object.keys(result.stressThresholds).sort()).toEqual(["hrvThresholds", "rhrThresholds"]);
  });

  it("returns all four defaults when stored is a full-null object", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      stressThresholds: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.exponentialMovingAverage).toEqual(DEFAULT_PARAMS.exponentialMovingAverage);
    expect(result.stressThresholds).toEqual(DEFAULT_PARAMS.stressThresholds);
  });

  it("picks stored chronicTrainingLoadDays not acuteTrainingLoadDays for exponentialMovingAverage.chronicTrainingLoadDays", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: {
        chronicTrainingLoadDays: 49,
        acuteTrainingLoadDays: 11,
        sampleCount: 100,
        correlation: 0.3,
      },
      stressThresholds: null,
    };
    const result = getEffectiveParams(stored);
    // Must be chronicTrainingLoadDays, not acuteTrainingLoadDays
    expect(result.exponentialMovingAverage.chronicTrainingLoadDays).toBe(49);
    expect(result.exponentialMovingAverage.chronicTrainingLoadDays).not.toBe(11);
  });

  it("picks stored acuteTrainingLoadDays not chronicTrainingLoadDays for exponentialMovingAverage.acuteTrainingLoadDays", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: {
        chronicTrainingLoadDays: 49,
        acuteTrainingLoadDays: 11,
        sampleCount: 100,
        correlation: 0.3,
      },
      stressThresholds: null,
    };
    const result = getEffectiveParams(stored);
    expect(result.exponentialMovingAverage.acuteTrainingLoadDays).toBe(11);
    expect(result.exponentialMovingAverage.acuteTrainingLoadDays).not.toBe(49);
  });

  it("picks stored hrvThresholds not rhrThresholds", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      stressThresholds: {
        hrvThresholds: [-2.0, -1.3, -0.7],
        rhrThresholds: [2.0, 1.3, 0.7],
        sampleCount: 100,
      },
    };
    const result = getEffectiveParams(stored);
    expect(result.stressThresholds.hrvThresholds).toEqual([-2.0, -1.3, -0.7]);
    expect(result.stressThresholds.hrvThresholds).not.toEqual([2.0, 1.3, 0.7]);
    expect(result.stressThresholds.rhrThresholds).toEqual([2.0, 1.3, 0.7]);
    expect(result.stressThresholds.rhrThresholds).not.toEqual([-2.0, -1.3, -0.7]);
  });
});
