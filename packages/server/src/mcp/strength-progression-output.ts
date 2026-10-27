import { z } from "zod";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestampSchema = z.string().datetime({ offset: true });
const nullableNumber = z.number().nullable();
const sourceExternalIdSchema = z
  .object({
    providerId: z.string(),
    externalId: z.string(),
    memberActivityId: z.string().optional(),
    subsource: z.string().nullable().optional(),
  })
  .strict();
const rawValuesSchema = z.record(z.string(), z.unknown());
const estimateEvidenceSchema = z
  .object({
    date: dateSchema,
    value_kg: z.number().positive(),
    set_id: z.uuid(),
    activity_id: z.uuid(),
    weight_kg: z.number().positive().nullable(),
    reps: z.number().int().positive().nullable(),
  })
  .strict();
const exerciseIdentitySchema = {
  exercise_id: z.uuid(),
  name: z.string().min(1),
  equipment: z.string().nullable(),
  muscle_groups: z.array(z.string()),
  exercise_type: z.string().nullable(),
  movement: z.string().nullable(),
  normalized_identity: z.literal(true),
};

/** Strict MCP wire contract for anomaly-safe longitudinal strength progression. */
export const strengthProgressionOutputSchema = z
  .object({
    result: z
      .object({
        range: z
          .object({ start_date: dateSchema, end_date: dateSchema, timezone: z.string() })
          .strict(),
        channel: z
          .object({
            id: z.literal("strength"),
            interchangeable_with: z.array(z.string()),
            note: z.string().min(1),
          })
          .strict(),
        definitions: z
          .object({
            estimated_one_rep_max: z.string().min(1),
            volume: z.string().min(1),
            working_set: z.string().min(1),
            anomaly_handling: z.string().min(1),
            duplicate_handling: z.string().min(1),
            personal_records: z.string().min(1),
          })
          .strict(),
        coverage: z
          .object({
            sessions: z.number().int().nonnegative(),
            source_sets: z.number().int().nonnegative(),
            sets: z.number().int().nonnegative(),
            first_observed_date: dateSchema.nullable(),
            timezone_assumed_sessions: z.number().int().nonnegative(),
            merged_exact_duplicate_records: z.number().int().nonnegative(),
            possible_duplicate_groups: z.number().int().nonnegative(),
            flagged_sets: z.number().int().nonnegative(),
            sets_excluded_from_volume: z.number().int().nonnegative(),
            sets_excluded_from_estimated_one_rep_max: z.number().int().nonnegative(),
          })
          .strict(),
        summary: z
          .object({
            sessions: z.number().int().nonnegative(),
            exercises: z.number().int().nonnegative(),
            frequency_days: z.number().int().nonnegative(),
            valid_working_sets: z.number().int().nonnegative(),
            total_volume_kg_reps: z.number().nonnegative(),
          })
          .strict(),
        exercises: z.array(
          z
            .object({
              ...exerciseIdentitySchema,
              frequency_days: z.number().int().nonnegative(),
              frequency_sessions: z.number().int().nonnegative(),
              working_sets: z.number().int().nonnegative(),
              valid_working_sets: z.number().int().nonnegative(),
              total_volume_kg_reps: z.number().nonnegative(),
              estimated_one_rep_max: z
                .object({
                  formula: z.literal("Epley"),
                  first_kg: nullableNumber,
                  latest_kg: nullableNumber,
                  best_kg: nullableNumber,
                  change_kg: nullableNumber,
                  change_percent: nullableNumber,
                  observations: z.array(estimateEvidenceSchema),
                })
                .strict(),
              daily: z.array(
                z
                  .object({
                    date: dateSchema,
                    sessions: z.number().int().nonnegative(),
                    working_sets: z.number().int().nonnegative(),
                    valid_working_sets: z.number().int().nonnegative(),
                    total_volume_kg_reps: z.number().nonnegative(),
                    max_weight_kg: nullableNumber,
                    best_estimated_one_rep_max_kg: nullableNumber,
                  })
                  .strict(),
              ),
              prs: z.array(
                estimateEvidenceSchema
                  .extend({
                    previous_best_kg: z.number().positive().nullable(),
                    previous_best_evidence: estimateEvidenceSchema.nullable(),
                  })
                  .strict(),
              ),
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
              exercises: z.array(
                z
                  .object({
                    ...exerciseIdentitySchema,
                    sets: z.array(
                      z
                        .object({
                          id: z.uuid(),
                          exercise_index: z.number().int().nonnegative(),
                          set_index: z.number().int().nonnegative(),
                          set_type: z.string().nullable(),
                          is_warmup: z.boolean(),
                          is_working_set: z.boolean(),
                          normalized: z
                            .object({
                              weight_kg: nullableNumber,
                              reps: z.number().int().nullable(),
                              rpe: nullableNumber,
                              rir: z.null(),
                              rir_status: z.literal("not_recorded_by_canonical_schema"),
                              distance_meters: nullableNumber,
                              duration_seconds: z.number().int().nullable(),
                              notes: z.string().nullable(),
                            })
                            .strict(),
                          original: z
                            .object({
                              status: z.enum(["available", "unavailable"]),
                              values: rawValuesSchema.nullable(),
                              reason: z.string().nullable(),
                              records: z.array(
                                z
                                  .object({
                                    provider: z.string(),
                                    activity_id: z.uuid(),
                                    set_id: z.uuid(),
                                    values: rawValuesSchema,
                                    source_exercise_identity: z
                                      .object({
                                        provider_exercise_id: z.string().nullable(),
                                        provider_exercise_name: z.string().nullable(),
                                        status: z.enum(["available", "unavailable"]),
                                      })
                                      .strict(),
                                  })
                                  .strict(),
                              ),
                            })
                            .strict(),
                          volume: z
                            .object({
                              status: z.enum(["available", "unavailable"]),
                              value_kg_reps: nullableNumber,
                              reason: z.string().nullable(),
                            })
                            .strict(),
                          estimated_one_rep_max: z
                            .object({
                              status: z.enum(["available", "unavailable"]),
                              value_kg: nullableNumber,
                              formula: z.literal("Epley"),
                              reason: z.string().nullable(),
                            })
                            .strict(),
                          quality_flags: z.array(z.string()),
                          excluded_from_aggregates: z.boolean(),
                          provenance: z
                            .object({
                              value_kind: z.literal("mixed"),
                              source_set_ids: z.array(z.uuid()),
                              source_activity_ids: z.array(z.uuid()),
                              source_providers: z.array(z.string()),
                              merged_duplicate: z.boolean(),
                              calculated_fields: z.array(z.string()),
                            })
                            .strict(),
                        })
                        .strict(),
                    ),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
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
