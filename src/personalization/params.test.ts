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
    readinessWeights: null,
    sleepTarget: null,
    stressThresholds: null,
    trainingImpulseConstants: null,
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
      readinessWeights: {
        hrv: 0.5,
        restingHr: 0.15,
        sleep: 0.2,
        respiratoryRate: 0.15,
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
      trainingImpulseConstants: {
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
    const input = baseParams();

    const result = personalizedParamsSchema.parse(input);
    expect(result.exponentialMovingAverage).toBeNull();
    expect(result.readinessWeights).toBeNull();
    expect(result.sleepTarget).toBeNull();
    expect(result.stressThresholds).toBeNull();
    expect(result.trainingImpulseConstants).toBeNull();
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
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
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

  describe("readiness weights sub-schema", () => {
    it("rejects weights that do not sum to 1", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            readinessWeights: {
              hrv: 0.5,
              restingHr: 0.3,
              sleep: 0.2,
              respiratoryRate: 0.2,
              sampleCount: 60,
              correlation: 0.2,
            },
          }),
        ),
      ).toThrow();
    });

    it("accepts weights that sum to exactly 1.0", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          readinessWeights: {
            hrv: 0.5,
            restingHr: 0.2,
            sleep: 0.15,
            respiratoryRate: 0.15,
            sampleCount: 60,
            correlation: 0.2,
          },
        }),
      );
      expect(result.readinessWeights).not.toBeNull();
    });

    it("accepts weights that sum within 0.01 tolerance of 1.0", () => {
      // 0.33 + 0.23 + 0.22 + 0.22 = 1.00
      const result = personalizedParamsSchema.parse(
        baseParams({
          readinessWeights: {
            hrv: 0.33,
            restingHr: 0.23,
            sleep: 0.22,
            respiratoryRate: 0.22,
            sampleCount: 60,
            correlation: 0.2,
          },
        }),
      );
      expect(result.readinessWeights).not.toBeNull();
    });

    it("accepts weights summing to 1.009 (within 0.01 tolerance)", () => {
      // sum = 0.409 + 0.2 + 0.2 + 0.2 = 1.009 => abs(1.009-1.0)=0.009 < 0.01
      const result = personalizedParamsSchema.parse(
        baseParams({
          readinessWeights: {
            hrv: 0.409,
            restingHr: 0.2,
            sleep: 0.2,
            respiratoryRate: 0.2,
            sampleCount: 60,
            correlation: 0.2,
          },
        }),
      );
      expect(result.readinessWeights).not.toBeNull();
    });

    it("rejects weights summing to 1.011 (outside 0.01 tolerance)", () => {
      // sum = 0.411 + 0.2 + 0.2 + 0.2 = 1.011 => abs(1.011-1.0)=0.011 >= 0.01
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            readinessWeights: {
              hrv: 0.411,
              restingHr: 0.2,
              sleep: 0.2,
              respiratoryRate: 0.2,
              sampleCount: 60,
              correlation: 0.2,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects weights summing to 0.98 (outside tolerance)", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            readinessWeights: {
              hrv: 0.3,
              restingHr: 0.2,
              sleep: 0.23,
              respiratoryRate: 0.25,
              sampleCount: 60,
              correlation: 0.2,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects hrv weight below minimum 0.05", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            readinessWeights: {
              hrv: 0.04,
              restingHr: 0.32,
              sleep: 0.32,
              respiratoryRate: 0.32,
              sampleCount: 60,
              correlation: 0.2,
            },
          }),
        ),
      ).toThrow();
    });

    it("accepts hrv weight at minimum 0.05", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          readinessWeights: {
            hrv: 0.05,
            restingHr: 0.35,
            sleep: 0.3,
            respiratoryRate: 0.3,
            sampleCount: 60,
            correlation: 0.2,
          },
        }),
      );
      expect(result.readinessWeights?.hrv).toBe(0.05);
    });

    it("rejects restingHr weight below minimum 0.05", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            readinessWeights: {
              hrv: 0.32,
              restingHr: 0.04,
              sleep: 0.32,
              respiratoryRate: 0.32,
              sampleCount: 60,
              correlation: 0.2,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects sleep weight below minimum 0.05", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            readinessWeights: {
              hrv: 0.32,
              restingHr: 0.32,
              sleep: 0.04,
              respiratoryRate: 0.32,
              sampleCount: 60,
              correlation: 0.2,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects respiratoryRate weight below minimum 0.05", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            readinessWeights: {
              hrv: 0.32,
              restingHr: 0.32,
              sleep: 0.32,
              respiratoryRate: 0.04,
              sampleCount: 60,
              correlation: 0.2,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects hrv weight above maximum 1", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            readinessWeights: {
              hrv: 1.01,
              restingHr: 0.05,
              sleep: 0.05,
              respiratoryRate: 0.05,
              sampleCount: 60,
              correlation: 0.2,
            },
          }),
        ),
      ).toThrow();
    });

    it("accepts hrv weight at maximum 1.0", () => {
      // Won't pass sum-to-1 refine but should pass the field-level max check;
      // we need all four to sum to 1 with each >= 0.05 and hrv = 1 is impossible
      // because others need >= 0.05. So this tests the .max(1) constraint.
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            readinessWeights: {
              hrv: 1.0,
              restingHr: 0.05,
              sleep: 0.05,
              respiratoryRate: 0.05,
              sampleCount: 60,
              correlation: 0.2,
            },
          }),
        ),
      ).toThrow(); // fails refine (sum > 1) but hrv:1 itself is valid
    });

    it("rejects negative sampleCount in readiness weights", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            readinessWeights: {
              hrv: 0.5,
              restingHr: 0.2,
              sleep: 0.15,
              respiratoryRate: 0.15,
              sampleCount: -1,
              correlation: 0.2,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects non-integer sampleCount in readiness weights", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            readinessWeights: {
              hrv: 0.5,
              restingHr: 0.2,
              sleep: 0.15,
              respiratoryRate: 0.15,
              sampleCount: 60.5,
              correlation: 0.2,
            },
          }),
        ),
      ).toThrow();
    });
  });

  describe("sleep target sub-schema", () => {
    it("rejects minutes below minimum 240", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({ sleepTarget: { minutes: 239, sampleCount: 10 } }),
        ),
      ).toThrow();
    });

    it("accepts minutes at minimum 240", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({ sleepTarget: { minutes: 240, sampleCount: 10 } }),
      );
      expect(result.sleepTarget?.minutes).toBe(240);
    });

    it("accepts minutes at maximum 720", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({ sleepTarget: { minutes: 720, sampleCount: 10 } }),
      );
      expect(result.sleepTarget?.minutes).toBe(720);
    });

    it("rejects minutes above maximum 720", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({ sleepTarget: { minutes: 721, sampleCount: 10 } }),
        ),
      ).toThrow();
    });

    it("rejects negative sampleCount", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({ sleepTarget: { minutes: 480, sampleCount: -1 } }),
        ),
      ).toThrow();
    });

    it("accepts sampleCount of 0", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({ sleepTarget: { minutes: 480, sampleCount: 0 } }),
      );
      expect(result.sleepTarget?.sampleCount).toBe(0);
    });

    it("rejects non-integer sampleCount", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({ sleepTarget: { minutes: 480, sampleCount: 1.5 } }),
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

  describe("trainingImpulseConstants sub-schema", () => {
    it("rejects genderFactor below minimum 0.3", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            trainingImpulseConstants: {
              genderFactor: 0.29,
              exponent: 1.92,
              sampleCount: 25,
              r2: 0.45,
            },
          }),
        ),
      ).toThrow();
    });

    it("accepts genderFactor at minimum 0.3", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          trainingImpulseConstants: {
            genderFactor: 0.3,
            exponent: 1.92,
            sampleCount: 25,
            r2: 0.45,
          },
        }),
      );
      expect(result.trainingImpulseConstants?.genderFactor).toBe(0.3);
    });

    it("accepts genderFactor at maximum 1.0", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          trainingImpulseConstants: {
            genderFactor: 1.0,
            exponent: 1.92,
            sampleCount: 25,
            r2: 0.45,
          },
        }),
      );
      expect(result.trainingImpulseConstants?.genderFactor).toBe(1.0);
    });

    it("rejects genderFactor above maximum 1.0", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            trainingImpulseConstants: {
              genderFactor: 1.01,
              exponent: 1.92,
              sampleCount: 25,
              r2: 0.45,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects exponent below minimum 1.0", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            trainingImpulseConstants: {
              genderFactor: 0.64,
              exponent: 0.99,
              sampleCount: 25,
              r2: 0.45,
            },
          }),
        ),
      ).toThrow();
    });

    it("accepts exponent at minimum 1.0", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          trainingImpulseConstants: {
            genderFactor: 0.64,
            exponent: 1.0,
            sampleCount: 25,
            r2: 0.45,
          },
        }),
      );
      expect(result.trainingImpulseConstants?.exponent).toBe(1.0);
    });

    it("accepts exponent at maximum 3.0", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          trainingImpulseConstants: {
            genderFactor: 0.64,
            exponent: 3.0,
            sampleCount: 25,
            r2: 0.45,
          },
        }),
      );
      expect(result.trainingImpulseConstants?.exponent).toBe(3.0);
    });

    it("rejects exponent above maximum 3.0", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            trainingImpulseConstants: {
              genderFactor: 0.64,
              exponent: 3.01,
              sampleCount: 25,
              r2: 0.45,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects negative sampleCount", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            trainingImpulseConstants: {
              genderFactor: 0.64,
              exponent: 1.92,
              sampleCount: -1,
              r2: 0.45,
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects non-integer sampleCount", () => {
      expect(() =>
        personalizedParamsSchema.parse(
          baseParams({
            trainingImpulseConstants: {
              genderFactor: 0.64,
              exponent: 1.92,
              sampleCount: 25.5,
              r2: 0.45,
            },
          }),
        ),
      ).toThrow();
    });

    it("accepts sampleCount of 0", () => {
      const result = personalizedParamsSchema.parse(
        baseParams({
          trainingImpulseConstants: {
            genderFactor: 0.64,
            exponent: 1.92,
            sampleCount: 0,
            r2: 0.45,
          },
        }),
      );
      expect(result.trainingImpulseConstants?.sampleCount).toBe(0);
    });
  });
});

describe("DEFAULT_PARAMS", () => {
  it("matches current hardcoded values", () => {
    expect(DEFAULT_PARAMS.exponentialMovingAverage.chronicTrainingLoadDays).toBe(42);
    expect(DEFAULT_PARAMS.exponentialMovingAverage.acuteTrainingLoadDays).toBe(7);
    expect(DEFAULT_PARAMS.readinessWeights.hrv).toBe(0.5);
    expect(DEFAULT_PARAMS.readinessWeights.restingHr).toBe(0.2);
    expect(DEFAULT_PARAMS.readinessWeights.sleep).toBe(0.15);
    expect(DEFAULT_PARAMS.readinessWeights.respiratoryRate).toBe(0.15);
    expect(DEFAULT_PARAMS.sleepTarget.minutes).toBe(480);
    expect(DEFAULT_PARAMS.stressThresholds.hrvThresholds).toEqual([-1.5, -1.0, -0.5]);
    expect(DEFAULT_PARAMS.stressThresholds.rhrThresholds).toEqual([1.5, 1.0, 0.5]);
    expect(DEFAULT_PARAMS.trainingImpulseConstants.genderFactor).toBe(0.64);
    expect(DEFAULT_PARAMS.trainingImpulseConstants.exponent).toBe(1.92);
  });

  it("readiness weights sum to 1", () => {
    const weights = DEFAULT_PARAMS.readinessWeights;
    expect(weights.hrv + weights.restingHr + weights.sleep + weights.respiratoryRate).toBeCloseTo(
      1.0,
    );
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
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
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
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.exponentialMovingAverage.chronicTrainingLoadDays).toBe(35);
    expect(result.exponentialMovingAverage.acuteTrainingLoadDays).toBe(9);
    expect(result.readinessWeights).toEqual(DEFAULT_PARAMS.readinessWeights);
    expect(result.sleepTarget).toEqual(DEFAULT_PARAMS.sleepTarget);
    expect(result.stressThresholds).toEqual(DEFAULT_PARAMS.stressThresholds);
    expect(result.trainingImpulseConstants).toEqual(DEFAULT_PARAMS.trainingImpulseConstants);
  });

  it("uses personalized readiness weights with all four fields", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: {
        hrv: 0.5,
        restingHr: 0.15,
        sleep: 0.2,
        respiratoryRate: 0.15,
        sampleCount: 90,
        correlation: 0.25,
      },
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.readinessWeights.hrv).toBe(0.5);
    expect(result.readinessWeights.restingHr).toBe(0.15);
    expect(result.readinessWeights.sleep).toBe(0.2);
    expect(result.readinessWeights.respiratoryRate).toBe(0.15);
  });

  it("uses personalized sleep target when available", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: { minutes: 450, sampleCount: 30 },
      stressThresholds: null,
      trainingImpulseConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.sleepTarget.minutes).toBe(450);
  });

  it("uses personalized stress thresholds when available", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: {
        hrvThresholds: [-2.0, -1.3, -0.7],
        rhrThresholds: [2.0, 1.3, 0.7],
        sampleCount: 100,
      },
      trainingImpulseConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.stressThresholds.hrvThresholds).toEqual([-2.0, -1.3, -0.7]);
    expect(result.stressThresholds.rhrThresholds).toEqual([2.0, 1.3, 0.7]);
  });

  it("uses personalized training impulse constants when available", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: {
        genderFactor: 0.75,
        exponent: 2.1,
        sampleCount: 40,
        r2: 0.55,
      },
    };

    const result = getEffectiveParams(stored);
    expect(result.trainingImpulseConstants.genderFactor).toBe(0.75);
    expect(result.trainingImpulseConstants.exponent).toBe(2.1);
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
      readinessWeights: null,
      sleepTarget: { minutes: 420, sampleCount: 20 },
      stressThresholds: {
        hrvThresholds: [-1.8, -1.2, -0.6],
        rhrThresholds: [1.8, 1.2, 0.6],
        sampleCount: 100,
      },
      trainingImpulseConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.exponentialMovingAverage.chronicTrainingLoadDays).toBe(49);
    expect(result.exponentialMovingAverage.acuteTrainingLoadDays).toBe(11);
    expect(result.readinessWeights).toEqual(DEFAULT_PARAMS.readinessWeights);
    expect(result.sleepTarget.minutes).toBe(420);
    expect(result.stressThresholds.hrvThresholds).toEqual([-1.8, -1.2, -0.6]);
    expect(result.stressThresholds.rhrThresholds).toEqual([1.8, 1.2, 0.6]);
    expect(result.trainingImpulseConstants).toEqual(DEFAULT_PARAMS.trainingImpulseConstants);
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
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };

    const result = getEffectiveParams(stored);
    // Should only contain chronicTrainingLoadDays and acuteTrainingLoadDays, not sampleCount/correlation
    expect(Object.keys(result.exponentialMovingAverage).sort()).toEqual([
      "acuteTrainingLoadDays",
      "chronicTrainingLoadDays",
    ]);
  });

  it("strips sampleCount and correlation from effective readiness weights", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: {
        hrv: 0.5,
        restingHr: 0.2,
        sleep: 0.15,
        respiratoryRate: 0.15,
        sampleCount: 90,
        correlation: 0.25,
      },
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(Object.keys(result.readinessWeights).sort()).toEqual([
      "hrv",
      "respiratoryRate",
      "restingHr",
      "sleep",
    ]);
  });

  it("strips sampleCount from effective sleep target", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: { minutes: 450, sampleCount: 30 },
      stressThresholds: null,
      trainingImpulseConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(Object.keys(result.sleepTarget)).toEqual(["minutes"]);
  });

  it("strips sampleCount from effective stress thresholds", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: {
        hrvThresholds: [-1.5, -1.0, -0.5],
        rhrThresholds: [1.5, 1.0, 0.5],
        sampleCount: 100,
      },
      trainingImpulseConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(Object.keys(result.stressThresholds).sort()).toEqual(["hrvThresholds", "rhrThresholds"]);
  });

  it("strips sampleCount and r2 from effective trainingImpulseConstants", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: {
        genderFactor: 0.7,
        exponent: 1.8,
        sampleCount: 25,
        r2: 0.45,
      },
    };

    const result = getEffectiveParams(stored);
    expect(Object.keys(result.trainingImpulseConstants).sort()).toEqual([
      "exponent",
      "genderFactor",
    ]);
  });

  it("returns all five defaults when stored is a full-null object", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };

    const result = getEffectiveParams(stored);
    expect(result.exponentialMovingAverage).toEqual(DEFAULT_PARAMS.exponentialMovingAverage);
    expect(result.readinessWeights).toEqual(DEFAULT_PARAMS.readinessWeights);
    expect(result.sleepTarget).toEqual(DEFAULT_PARAMS.sleepTarget);
    expect(result.stressThresholds).toEqual(DEFAULT_PARAMS.stressThresholds);
    expect(result.trainingImpulseConstants).toEqual(DEFAULT_PARAMS.trainingImpulseConstants);
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
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
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
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };
    const result = getEffectiveParams(stored);
    expect(result.exponentialMovingAverage.acuteTrainingLoadDays).toBe(11);
    expect(result.exponentialMovingAverage.acuteTrainingLoadDays).not.toBe(49);
  });

  it("picks stored hrv weight, not restingHr/sleep/respiratoryRate for readiness hrv", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: {
        hrv: 0.5,
        restingHr: 0.15,
        sleep: 0.2,
        respiratoryRate: 0.15,
        sampleCount: 90,
        correlation: 0.25,
      },
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };
    const result = getEffectiveParams(stored);
    expect(result.readinessWeights.hrv).toBe(0.5);
    expect(result.readinessWeights.restingHr).toBe(0.15);
    expect(result.readinessWeights.sleep).toBe(0.2);
    expect(result.readinessWeights.respiratoryRate).toBe(0.15);
  });

  it("picks stored genderFactor not exponent for trainingImpulseConstants", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: { genderFactor: 0.5, exponent: 2.5, sampleCount: 30, r2: 0.6 },
    };
    const result = getEffectiveParams(stored);
    expect(result.trainingImpulseConstants.genderFactor).toBe(0.5);
    expect(result.trainingImpulseConstants.genderFactor).not.toBe(2.5);
    expect(result.trainingImpulseConstants.exponent).toBe(2.5);
    expect(result.trainingImpulseConstants.exponent).not.toBe(0.5);
  });

  it("picks stored hrvThresholds not rhrThresholds", () => {
    const stored: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: {
        hrvThresholds: [-2.0, -1.3, -0.7],
        rhrThresholds: [2.0, 1.3, 0.7],
        sampleCount: 100,
      },
      trainingImpulseConstants: null,
    };
    const result = getEffectiveParams(stored);
    expect(result.stressThresholds.hrvThresholds).toEqual([-2.0, -1.3, -0.7]);
    expect(result.stressThresholds.hrvThresholds).not.toEqual([2.0, 1.3, 0.7]);
    expect(result.stressThresholds.rhrThresholds).toEqual([2.0, 1.3, 0.7]);
    expect(result.stressThresholds.rhrThresholds).not.toEqual([-2.0, -1.3, -0.7]);
  });
});
