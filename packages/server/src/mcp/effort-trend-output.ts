import { z } from "zod";
import { performanceComparisonEquivalenceSchema } from "./performance-comparison-output.ts";

export const comparableEffortMetricsSchema = z
  .object({
    duration_seconds: z.number().nullable(),
    moving_duration_seconds: z.number().nullable(),
    average_power_watts: z.number().nullable(),
    normalized_power_watts: z.number().nullable(),
    average_heart_rate_bpm: z.number().nullable(),
    average_cadence_rpm: z.number().nullable(),
    power_to_heart_rate_ratio: z.number().nullable(),
    distance_meters: z.number().nullable(),
    elevation_gain_meters: z.number().nullable(),
    average_temperature_c: z.number().nullable(),
    climbing_attempts: z.number().nullable(),
    climbing_sends: z.number().nullable(),
    strength_volume_kg_reps: z.number().nullable(),
    strength_estimated_one_rep_max_kg: z.number().nullable(),
  })
  .strict();

export const effortTrendEvidenceSchema = z.record(z.string(), z.unknown());

export const effortTrendResultSchema = z
  .object({
    equivalence: performanceComparisonEquivalenceSchema,
    repetitions: z.array(
      z
        .object({
          activity_id: z.uuid(),
          date: z.string(),
          started_at: z.string(),
          comparable_metrics: comparableEffortMetricsSchema,
          delta_to_first: comparableEffortMetricsSchema,
          delta_to_previous: comparableEffortMetricsSchema,
          delta_to_best: comparableEffortMetricsSchema,
          rolling: z
            .object({
              window_repetitions: z.literal(3),
              observation_count: z.number().int().nonnegative(),
              metric_observation_counts: z.record(
                comparableEffortMetricsSchema.keyof(),
                z.number().int().nonnegative().max(3),
              ),
              comparable_metrics: comparableEffortMetricsSchema,
              status: z.enum(["available", "insufficient_observations"]),
              reason: z.string().nullable(),
            })
            .strict(),
          quality: z.object({ comparable: z.boolean(), flags: z.array(z.string()) }).strict(),
          evidence: z.array(effortTrendEvidenceSchema),
          assumptions: z.array(z.string()),
          caveats: z.array(z.string()),
        })
        .strict(),
    ),
    definitions: z
      .object({
        deltas: z.string(),
        rolling: z.string(),
        best: z.string(),
      })
      .strict(),
    quality: z
      .object({
        comparable_repetitions: z.number().int().nonnegative(),
        total_repetitions: z.number().int().nonnegative(),
      })
      .strict(),
    evidence: z.array(effortTrendEvidenceSchema),
    assumptions: z.array(z.string()),
    caveats: z.array(z.string()),
  })
  .strict();

export const effortTrendOutputSchema = z.strictObject({ result: effortTrendResultSchema });
