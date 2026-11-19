import { localTimeSourceSchema } from "@dofek/format/record-local-time";
import { z } from "zod";
import { preSleepActivitySchema } from "../repositories/pre-sleep-activity-repository.ts";
import { recoveryTrainingStreamSchema } from "../repositories/recovery-training-series-repository.ts";
import { sleepEpisodeTimingSchema } from "../repositories/sleep-episode-analysis.ts";
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

export const recoveryTrainingFieldSchema = z.enum([
  "health",
  "sleep",
  "body_weight",
  "training_load",
  "previous_day_training_load",
  "activity_exposure",
  "nutrition",
]);

export const recoveryTrainingGrainSchema = z.enum(["local_day", "main_sleep"]);

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
        requested_fields: z.array(recoveryTrainingFieldSchema).optional(),
        grain: recoveryTrainingGrainSchema.optional(),
        calendar_day_count: z.number().int().positive().optional(),
        eligible_count: z.number().int().nonnegative().optional(),
        observed_counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
        next_cursor: z.string().nullable().optional(),
        sleep_source_changes: z
          .array(
            z.object({
              previous_date: z.string(),
              date: z.string(),
              previous_provider: z.string(),
              provider: z.string(),
              previous_source_name: z.string().nullable(),
              source_name: z.string().nullable(),
            }),
          )
          .optional(),
        workout_finish_counts: z
          .array(
            z.object({
              weekday: z.string(),
              before: z.number().int().nonnegative(),
              at_or_after: z.number().int().nonnegative(),
              unknown: z.number().int().nonnegative(),
            }),
          )
          .optional(),
        filters: z
          .object({
            providers: z.array(z.string()),
            modalities: z.array(z.string()),
            canonical_activity_types: z.array(z.string()).optional(),
            required_meals: z.array(z.string()).optional(),
          })
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
              weekday: z.string().optional(),
              row_id: z.string().optional(),
              sleep_episode_ids: z.array(z.string()).optional(),
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
                  sleepEpisodeTimingSchema
                    .omit({ local_time_context: true })
                    .extend({
                      status: z.literal("observed"),
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
                          "awake_minutes",
                        ]),
                      ),
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
              activity_exposure: z
                .object({
                  activity_count: z.number().int().nonnegative(),
                  duration: z
                    .object({
                      value_minutes: nullableNumber,
                      status: z.enum(["observed", "partial", "unavailable", "no_records"]),
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
                .or(preSleepActivitySchema)
                .optional(),
              nutrition: nutritionSummaryItemSchema.nullable().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();
