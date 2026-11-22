import { z } from "zod";

const nullableString = z.string().nullable();
export const cyclingPowerProfileDurations = [5, 60, 300] as const;

const cyclingPowerCurveWeightSourceSchema = z
  .object({
    date: z.string(),
    recorded_at: z.string(),
    value_kg: z.number().positive(),
    provider: z.string().min(1),
    source_record_id: nullableString,
    record_id: z.uuid().optional(),
    measurement_kind: z.literal("direct"),
  })
  .strict();
const cyclingPowerCurveWeightSchema = z.union([
  z
    .object({
      value_kg: z.number().positive(),
      kind: z.enum(["measured", "interpolated", "nearest"]),
      method: z.enum(["same_day", "linear_interpolation", "nearest_within_30_days"]),
      quality: z.enum(["high", "medium", "low"]),
      distance_days: z.number().nonnegative(),
      sources: z.array(cyclingPowerCurveWeightSourceSchema).min(1),
    })
    .strict(),
  z.object({ value_kg: z.null(), reason: z.string().min(1) }).strict(),
]);
export const cyclingPowerCurveEffortSchema = z
  .object({
    duration_seconds: z.number().int().positive(),
    watts: z.number().nonnegative(),
    watts_per_kg: z.number().nonnegative().nullable(),
    watts_per_kg_reason: nullableString,
    weight: cyclingPowerCurveWeightSchema,
    activity_id: z.uuid(),
    date: z.string(),
    started_at: z.string(),
    start_offset_seconds: z.number().nonnegative().nullable(),
    canonical_type: z.string(),
    power_kind: z.enum(["direct", "estimated", "unknown"]),
    source_providers: z.array(z.string()),
    source_devices: z.array(z.string()),
    member_activity_ids: z.array(z.uuid()),
    quality: z
      .object({
        status: z.enum(["high", "moderate", "limited"]),
        reasons: z.array(z.string()),
        observed_samples: z.number().int().nonnegative().nullable(),
        coverage_pct: z.number().min(0).max(100).nullable(),
        continuity_tolerance_seconds: z.number().positive().nullable(),
        median_sample_interval_seconds: z.number().positive().nullable(),
        largest_gap_seconds: z.number().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();

export const cyclingPowerProfileSchema = z.object({
  range: z.object({
    start_date: z.iso.date().nullable(),
    end_date: z.iso.date(),
    timezone: z.string(),
  }),
  maximal_test_status: z.literal("unverified"),
  efforts: z
    .array(
      z.object({
        duration_seconds: z.literal(cyclingPowerProfileDurations),
        effort: cyclingPowerCurveEffortSchema
          .extend({
            activity_name: nullableString,
            modality: nullableString,
            end_offset_seconds: z.number().nonnegative().nullable(),
          })
          .nullable(),
      }),
    )
    .length(cyclingPowerProfileDurations.length),
  threshold: z.object({
    watts: z.number().positive().nullable(),
    watts_per_kg: z.number().nonnegative().nullable(),
    effective_from: z.iso.date().nullable(),
    source_record_id: z.uuid().nullable(),
    method: z.literal("configured"),
    unavailable_reason: nullableString,
    weight: cyclingPowerCurveWeightSchema.nullable(),
  }),
});

export type CyclingPowerProfile = z.infer<typeof cyclingPowerProfileSchema>;
