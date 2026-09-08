import { localTimeSourceSchema } from "@dofek/format/record-local-time";
import { z } from "zod";
import { recoveryTrainingStreamSchema } from "../repositories/recovery-training-series-repository.ts";
import { analyticalTrainingLoadChannelSchema } from "./analytical-training-load-output.ts";
import { nutritionSummaryItemSchema } from "./nutrition-summary-output.ts";

const nullableNumber = z.number().nullable();
const localTimeContextSchema = z
  .object({
    timezone: z.string().nullable(),
    start_utc_offset_minutes: z.number().int().nullable(),
    end_utc_offset_minutes: z.number().int().nullable(),
    source: localTimeSourceSchema,
  })
  .strict();
const healthValueSchema = z
  .object({
    value: nullableNumber,
    status: z.enum(["observed", "missing"]),
    value_kind: z.literal("provider_supplied"),
    source_providers: z.array(z.string()),
    provenance_scope: z.literal("daily_row"),
  })
  .strict();
const restingHeartRateValueSchema = z
  .object({
    value: nullableNumber,
    status: z.enum(["observed", "missing"]),
    value_kind: z.literal("calculated_from_deduped_samples"),
    source_providers: z.array(z.string()),
    provenance_scope: z.literal("deduped_resting_hr_series"),
  })
  .strict();
const nearbyWeightEvidenceSchema = z.union([
  z
    .object({
      value_kg: z.null(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      value_kg: z.number().positive(),
      kind: z.enum(["measured", "interpolated", "nearest"]),
      method: z.enum(["same_day", "linear_interpolation", "nearest_within_30_days"]),
      quality: z.enum(["high", "medium", "low"]),
      distance_days: z.number().nonnegative(),
      sources: z.array(
        z
          .object({
            date: z.string(),
            recorded_at: z.string(),
            value_kg: z.number().positive(),
            provider: z.string(),
            source_record_id: z.string().nullable(),
            measurement_kind: z.literal("direct"),
          })
          .strict(),
      ),
    })
    .strict(),
]);
const loadChannelsSchema = z
  .object({
    cycling_power_tss: analyticalTrainingLoadChannelSchema,
    heart_rate_zone_load: analyticalTrainingLoadChannelSchema,
    session_rpe: analyticalTrainingLoadChannelSchema,
    climbing_attempts: analyticalTrainingLoadChannelSchema,
    finger_load: analyticalTrainingLoadChannelSchema,
    strength_volume: analyticalTrainingLoadChannelSchema,
  })
  .strict();
const injurySchema = z
  .object({
    id: z.string(),
    kind: z.enum(["injury", "niggle"]),
    body_region_id: z.string(),
    onset_date: z.string(),
    resolved_date: z.string().nullable(),
    severity: nullableNumber,
    description: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

/** Strict wire contract for compact, selected date-aligned recovery and exposure streams. */
export const recoveryTrainingSeriesOutputSchema = z
  .object({
    result: z
      .object({
        range: z
          .object({
            start_date: z.string(),
            end_date: z.string(),
            timezone: z.string(),
          })
          .strict(),
        requested_streams: z.array(recoveryTrainingStreamSchema),
        filters: z
          .object({ providers: z.array(z.string()), modalities: z.array(z.string()) })
          .strict(),
        interpretation: z
          .object({
            date_alignment: z.string().min(1),
            causality: z.string().min(1),
            filter_scope: z.string().min(1),
          })
          .strict(),
        rows: z.array(
          z
            .object({
              date: z.string(),
              health: z
                .object({
                  hrv: healthValueSchema,
                  resting_hr: restingHeartRateValueSchema,
                  respiratory_rate: healthValueSchema,
                  steps: healthValueSchema,
                })
                .strict()
                .optional(),
              sleep: z
                .union([
                  z.object({ status: z.literal("missing"), reason: z.string().min(1) }).strict(),
                  z
                    .object({
                      status: z.literal("observed"),
                      started_at: z.string(),
                      ended_at: z.string().nullable(),
                      duration_minutes: nullableNumber,
                      efficiency_pct: nullableNumber,
                      stages_minutes: z
                        .object({
                          deep: nullableNumber,
                          light: nullableNumber,
                          rem: nullableNumber,
                          awake: nullableNumber,
                        })
                        .strict(),
                      staging_available: z.boolean(),
                      missing_fields: z.array(
                        z.enum([
                          "duration_minutes",
                          "efficiency_pct",
                          "stages_minutes",
                          "ended_at",
                        ]),
                      ),
                      source_providers: z.array(z.string()),
                      selected_session_id: z.string().nullable(),
                      local_time_context: localTimeContextSchema,
                    })
                    .strict(),
                ])
                .optional(),
              body_weight: z
                .object({
                  direct_status: z.enum(["observed", "missing"]),
                  direct_value_kg: nullableNumber,
                  direct_measurement_kind: z.enum(["direct", "unavailable"]),
                  direct_source_provider: z.string().nullable(),
                  nearby_evidence: nearbyWeightEvidenceSchema,
                  rolling: z
                    .object({
                      average_7d_kg: nullableNumber,
                      average_28d_kg: nullableNumber,
                      observed_days_7d: z.number().int().nonnegative(),
                      observed_days_28d: z.number().int().nonnegative(),
                    })
                    .strict(),
                })
                .strict()
                .optional(),
              training_load: loadChannelsSchema.nullable().optional(),
              previous_day_training_load: loadChannelsSchema.nullable().optional(),
              subjective: z
                .object({
                  status: z.enum(["observed", "not_observed"]),
                  fatigue: z
                    .object({
                      value: z.null(),
                      status: z.literal("unavailable"),
                      reason: z.string().min(1),
                    })
                    .strict(),
                  symptoms: z.array(
                    z
                      .object({
                        id: z.string(),
                        body_region_id: z.string(),
                        kind: z.enum(["soreness", "stiffness", "tenderness"]),
                        score: z.number().int().min(1).max(10),
                      })
                      .strict(),
                  ),
                  active_injuries: z.array(injurySchema),
                })
                .strict()
                .optional(),
              activity_exposure: z
                .object({
                  activity_count: z.number().int().nonnegative(),
                  duration: z
                    .object({
                      value_minutes: nullableNumber,
                      status: z.enum(["observed", "partial", "unavailable"]),
                      reason: z.string().nullable(),
                      supported_activities: z.number().int().nonnegative(),
                      total_activities: z.number().int().nonnegative(),
                      missing_end_activities: z.number().int().nonnegative(),
                      invalid_interval_activities: z.number().int().nonnegative(),
                    })
                    .strict(),
                  canonical_types: z.array(z.string()),
                  modalities: z.array(z.string()),
                  source_providers: z.array(z.string()),
                  source_activity_ids: z.array(z.string()).max(100),
                  source_activity_count: z.number().int().nonnegative(),
                  source_activity_ids_truncated: z.boolean(),
                  date_attribution: z
                    .object({
                      authoritative_records: z.number().int().nonnegative(),
                      analysis_timezone_assumptions: z.number().int().nonnegative(),
                    })
                    .strict(),
                })
                .strict()
                .optional(),
              nutrition: nutritionSummaryItemSchema.nullable().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();
