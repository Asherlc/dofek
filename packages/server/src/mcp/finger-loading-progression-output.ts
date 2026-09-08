import { z } from "zod";
import {
  fingerLoadingExerciseSchema,
  fingerLoadingGripPositionSchema,
  fingerLoadingLateralitySchema,
} from "../repositories/climbing-training-log-repository.ts";

const nullableNumber = z.number().nullable();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestampSchema = z.string().datetime({ offset: true });
const sourceExternalIdSchema = z
  .object({
    providerId: z.string(),
    externalId: z.string(),
    memberActivityId: z.string().optional(),
    subsource: z.string().nullable().optional(),
  })
  .strict();
const thresholdsSchema = z
  .object({
    min_effective_load_kg: nullableNumber,
    min_load_to_bodyweight_ratio: nullableNumber,
    min_rpe: nullableNumber,
  })
  .strict();

/** Strict MCP wire contract for longitudinal finger-loading progression. */
export const fingerLoadingProgressionOutputSchema = z
  .object({
    result: z
      .object({
        range: z
          .object({ start_date: dateSchema, end_date: dateSchema, timezone: z.string() })
          .strict(),
        channel: z
          .object({
            id: z.literal("finger_loading"),
            interchangeable_with: z.array(z.string()),
            note: z.string().min(1),
          })
          .strict(),
        definitions: z
          .object({
            effective_load: z.string().min(1),
            time_under_tension: z.string().min(1),
            effective_load_kg_seconds: z.string().min(1),
            high_intensity: z.string().min(1),
            duplicate_handling: z.string().min(1),
            consecutive_days: z.string().min(1),
          })
          .strict(),
        coverage: z
          .object({
            sessions: z.number().int().nonnegative(),
            entries: z.number().int().nonnegative(),
            first_observed_date: dateSchema.nullable(),
            timezone_assumed_sessions: z.number().int().nonnegative(),
            merged_exact_duplicate_records: z.number().int().nonnegative(),
            possible_duplicate_groups: z.number().int().nonnegative(),
            entries_excluded_from_aggregates: z.number().int().nonnegative(),
          })
          .strict(),
        summary: z
          .object({
            sessions: z.number().int().nonnegative(),
            entries: z.number().int().nonnegative(),
            total_time_under_tension_seconds: z.number().nonnegative().nullable(),
            effective_load_kg_seconds: z.number().nonnegative().nullable(),
            exposure_calculation: z
              .object({ status: z.literal("unavailable"), reason: z.string().min(1) })
              .strict(),
            max_effective_load_kg: nullableNumber,
            max_load_to_bodyweight_ratio: nullableNumber,
          })
          .strict(),
        high_intensity: z
          .object({
            status: z.enum(["available", "unavailable"]),
            thresholds: thresholdsSchema,
            matching_entries: z.number().int().nonnegative().nullable(),
            days: z.number().int().nonnegative().nullable(),
            reason: z.string().min(1).nullable(),
          })
          .strict(),
        daily: z.array(
          z
            .object({
              date: dateSchema,
              exposure_status: z.enum(["observed", "not_observed", "unavailable"]),
              sessions: z.number().int().nonnegative().nullable(),
              entries: z.number().int().nonnegative().nullable(),
              entries_in_aggregates: z.number().int().nonnegative().nullable(),
              total_time_under_tension_seconds: z.number().nonnegative().nullable(),
              effective_load_kg_seconds: z.number().nonnegative().nullable(),
              max_effective_load_kg: nullableNumber,
              max_load_to_bodyweight_ratio: nullableNumber,
              high_intensity_entries: z.number().int().nonnegative().nullable(),
              high_intensity_day: z.boolean().nullable(),
              is_rest_day: z.boolean().nullable(),
              consecutive_finger_loading_days: z.number().int().nonnegative().nullable(),
            })
            .strict(),
        ),
        sessions: z.array(
          z
            .object({
              activity_id: z.uuid(),
              date: dateSchema,
              started_at: timestampSchema,
              duration_minutes: nullableNumber,
              name: z.string().nullable(),
              source_providers: z.array(z.string()),
              source_external_ids: z.array(sourceExternalIdSchema),
              member_activity_ids: z.array(z.uuid()),
              timezone: z
                .object({
                  value: z.string().nullable(),
                  start_utc_offset_minutes: z.number().int().nullable(),
                  end_utc_offset_minutes: z.number().int().nullable(),
                  local_time_source: z.string(),
                  analysis_timezone: z.string(),
                  assumed: z.boolean(),
                })
                .strict(),
              quality_flags: z.array(z.string()),
              entries: z.array(
                z
                  .object({
                    id: z.uuid(),
                    protocol: fingerLoadingExerciseSchema,
                    grip_type: fingerLoadingGripPositionSchema.nullable(),
                    edge_size_mm: nullableNumber,
                    original_external_load_kg: z.number(),
                    added_weight_kg: z.number().nonnegative(),
                    assistance_kg: z.number().nonnegative(),
                    bodyweight_kg: z.number().positive(),
                    effective_load_kg: z.number().positive(),
                    load_to_bodyweight_ratio: z.number().positive(),
                    hang_duration_seconds: z.number().positive(),
                    rest_duration_seconds: z.number().nonnegative(),
                    pain: z.null(),
                    pain_status: z.literal("not_recorded_by_canonical_schema"),
                    repetitions_per_set: z.null(),
                    repetitions_status: z.literal("not_recorded_by_canonical_schema"),
                    sets: z.number().int().positive(),
                    laterality: fingerLoadingLateralitySchema,
                    rpe: z.number().min(0).max(10).nullable(),
                    notes: z.string().nullable(),
                    total_time_under_tension_seconds: z.number().positive().nullable(),
                    effective_load_kg_seconds: z.number().positive().nullable(),
                    exposure_calculation: z
                      .object({ status: z.literal("unavailable"), reason: z.string().min(1) })
                      .strict(),
                    high_intensity: z.boolean().nullable(),
                    excluded_from_aggregates: z.boolean(),
                    quality_flags: z.array(z.string()),
                    provenance: z
                      .object({
                        value_kind: z.literal("mixed"),
                        source_recorded_fields: z.array(z.string()),
                        calculated_fields: z.array(z.string()),
                        source_entry_ids: z.array(z.uuid()),
                        source_activity_ids: z.array(z.uuid()),
                        source_providers: z.array(z.string()),
                        merged_duplicate: z.boolean(),
                      })
                      .strict(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
        combined_climbing_finger_exposure: z
          .object({
            definition: z.string().min(1),
            first_joint_coverage_date: dateSchema.nullable(),
            daily: z.array(
              z
                .object({
                  date: dateSchema,
                  finger_loading: z.boolean().nullable(),
                  finger_loading_status: z.enum(["observed", "not_observed", "unavailable"]),
                  climbing: z.boolean().nullable(),
                  climbing_status: z.enum(["observed", "not_observed", "unavailable"]),
                  any_exposure: z.boolean().nullable(),
                  exposure_status: z.enum(["observed", "not_observed", "unavailable"]),
                  consecutive_exposure_days: z.number().int().nonnegative().nullable(),
                })
                .strict(),
            ),
          })
          .strict(),
        pagination: z
          .object({
            limit: z.number().int().positive(),
            has_more: z.boolean(),
            next_cursor: z.string().nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
