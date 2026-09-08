import { z } from "zod";
import { nutritionSummaryItemSchema } from "./nutrition-summary-output.ts";

const nullableNumber = z.number().nullable();
const rollingSchema = z
  .object({
    acute_7d_sum: nullableNumber,
    chronic_28d_weekly_equivalent: nullableNumber,
    workload_ratio: nullableNumber,
    monotony_7d: nullableNumber,
    strain_7d: nullableNumber,
    acute_coverage_days: z.number().int().min(0).max(7),
    chronic_coverage_days: z.number().int().min(0).max(28),
    unavailable_reasons: z.array(z.string()),
  })
  .strict();
export const analyticalTrainingLoadChannelSchema = z
  .object({
    daily_value: nullableNumber,
    unit: z.string().min(1),
    value_kind: z.literal("calculated"),
    status: z.enum(["available", "partial", "unavailable", "not_observed"]),
    reason: z.string().nullable(),
    source_activity_ids: z.array(z.uuid()).max(100),
    source_providers: z.array(z.string()),
    coverage: z
      .object({
        contributing_records: z.number().int().nonnegative(),
        supported_records: z.number().int().nonnegative(),
        first_observed_date: z.string().nullable(),
        source_activity_count: z.number().int().nonnegative(),
        source_activity_ids_truncated: z.boolean(),
      })
      .strict(),
    context: z.record(z.string(), z.number()),
    date_attribution: z
      .object({
        authoritative_activities: z.number().int().nonnegative(),
        analysis_timezone_activities: z.number().int().nonnegative(),
      })
      .strict(),
    rolling: rollingSchema,
  })
  .strict();

/** Strict MCP wire contract for modality-specific analytical daily load. */
export const analyticalTrainingLoadOutputSchema = z
  .object({
    result: z
      .object({
        range: z
          .object({
            start_date: z.string(),
            end_date: z.string(),
            timezone: z.string(),
            date_policy: z.enum(["analysis_timezone", "source_context"]),
          })
          .strict(),
        definitions: z
          .object({
            cycling_power_tss: z.string().min(1),
            heart_rate_zone_load: z.string().min(1),
            session_rpe: z.string().min(1),
            climbing_attempts: z.string().min(1),
            finger_load: z.string().min(1),
            strength_volume: z.string().min(1),
            rolling: z.string().min(1),
            monotony_strain: z.string().min(1),
          })
          .strict(),
        total_daily_load: z
          .object({
            value: z.null(),
            reason: z.string().min(1),
          })
          .strict(),
        rows: z.array(
          z
            .object({
              date: z.string(),
              channels: z
                .object({
                  cycling_power_tss: analyticalTrainingLoadChannelSchema,
                  heart_rate_zone_load: analyticalTrainingLoadChannelSchema,
                  session_rpe: analyticalTrainingLoadChannelSchema,
                  climbing_attempts: analyticalTrainingLoadChannelSchema,
                  finger_load: analyticalTrainingLoadChannelSchema,
                  strength_volume: analyticalTrainingLoadChannelSchema,
                })
                .strict(),
            })
            .strict(),
        ),
        nutrition: z.array(nutritionSummaryItemSchema).optional(),
      })
      .strict(),
  })
  .strict();
