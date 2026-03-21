import { z } from "zod";

const exponentialMovingAverageParamsSchema = z.object({
  chronicTrainingLoadDays: z.number().int().min(21).max(63),
  acuteTrainingLoadDays: z.number().int().min(5).max(14),
  sampleCount: z.number().int().nonnegative(),
  correlation: z.number(),
});

const readinessWeightsSchema = z
  .object({
    hrv: z.number().min(0.05).max(1),
    restingHr: z.number().min(0.05).max(1),
    sleep: z.number().min(0.05).max(1),
    respiratoryRate: z.number().min(0.05).max(1),
    sampleCount: z.number().int().nonnegative(),
    correlation: z.number(),
  })
  .refine((w) => Math.abs(w.hrv + w.restingHr + w.sleep + w.respiratoryRate - 1.0) < 0.01, {
    message: "Readiness weights must sum to 1.0",
  });

const sleepTargetSchema = z.object({
  minutes: z.number().min(240).max(720),
  sampleCount: z.number().int().nonnegative(),
});

const stressThresholdsSchema = z
  .object({
    /** HRV z-score thresholds in descending magnitude order (most negative first) */
    hrvThresholds: z.tuple([z.number(), z.number(), z.number()]),
    /** RHR z-score thresholds in descending order (most positive first) */
    rhrThresholds: z.tuple([z.number(), z.number(), z.number()]),
    sampleCount: z.number().int().nonnegative(),
  })
  .refine(
    (t) => {
      const [h0, h1, h2] = t.hrvThresholds;
      return h0 < h1 && h1 < h2;
    },
    { message: "HRV thresholds must be in ascending order (most negative first)" },
  )
  .refine(
    (t) => {
      const [r0, r1, r2] = t.rhrThresholds;
      return r0 > r1 && r1 > r2;
    },
    { message: "RHR thresholds must be in descending order (most positive first)" },
  );

const trainingImpulseConstantsSchema = z.object({
  genderFactor: z.number().min(0.3).max(1.0),
  exponent: z.number().min(1.0).max(3.0),
  sampleCount: z.number().int().nonnegative(),
  r2: z.number(),
});

export const personalizedParamsSchema = z.object({
  version: z.number().int().min(1),
  fittedAt: z.string(),
  exponentialMovingAverage: exponentialMovingAverageParamsSchema.nullable(),
  readinessWeights: readinessWeightsSchema.nullable(),
  sleepTarget: sleepTargetSchema.nullable(),
  stressThresholds: stressThresholdsSchema.nullable(),
  trainingImpulseConstants: trainingImpulseConstantsSchema.nullable(),
});

export type PersonalizedParams = z.infer<typeof personalizedParamsSchema>;

export interface EffectiveParams {
  exponentialMovingAverage: { chronicTrainingLoadDays: number; acuteTrainingLoadDays: number };
  readinessWeights: { hrv: number; restingHr: number; sleep: number; respiratoryRate: number };
  sleepTarget: { minutes: number };
  stressThresholds: {
    hrvThresholds: [number, number, number];
    rhrThresholds: [number, number, number];
  };
  trainingImpulseConstants: { genderFactor: number; exponent: number };
}

export const DEFAULT_PARAMS: EffectiveParams = {
  exponentialMovingAverage: { chronicTrainingLoadDays: 42, acuteTrainingLoadDays: 7 },
  readinessWeights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
  sleepTarget: { minutes: 480 },
  stressThresholds: {
    hrvThresholds: [-1.5, -1.0, -0.5],
    rhrThresholds: [1.5, 1.0, 0.5],
  },
  trainingImpulseConstants: { genderFactor: 0.64, exponent: 1.92 },
};

/**
 * Merge stored personalized params with defaults.
 * Uses the stored value for each sub-object when non-null,
 * falls back to defaults otherwise.
 */
export function getEffectiveParams(stored: PersonalizedParams | null): EffectiveParams {
  if (stored == null) return DEFAULT_PARAMS;

  return {
    exponentialMovingAverage: stored.exponentialMovingAverage
      ? {
          chronicTrainingLoadDays: stored.exponentialMovingAverage.chronicTrainingLoadDays,
          acuteTrainingLoadDays: stored.exponentialMovingAverage.acuteTrainingLoadDays,
        }
      : DEFAULT_PARAMS.exponentialMovingAverage,
    readinessWeights: stored.readinessWeights
      ? {
          hrv: stored.readinessWeights.hrv,
          restingHr: stored.readinessWeights.restingHr,
          sleep: stored.readinessWeights.sleep,
          respiratoryRate: stored.readinessWeights.respiratoryRate,
        }
      : DEFAULT_PARAMS.readinessWeights,
    sleepTarget: stored.sleepTarget
      ? { minutes: stored.sleepTarget.minutes }
      : DEFAULT_PARAMS.sleepTarget,
    stressThresholds: stored.stressThresholds
      ? {
          hrvThresholds: stored.stressThresholds.hrvThresholds,
          rhrThresholds: stored.stressThresholds.rhrThresholds,
        }
      : DEFAULT_PARAMS.stressThresholds,
    trainingImpulseConstants: stored.trainingImpulseConstants
      ? {
          genderFactor: stored.trainingImpulseConstants.genderFactor,
          exponent: stored.trainingImpulseConstants.exponent,
        }
      : DEFAULT_PARAMS.trainingImpulseConstants,
  };
}
