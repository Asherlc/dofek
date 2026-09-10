import { z } from "zod";

const nullableNumber = z.number().nullable();
const sourceExternalIdSchema = z
  .object({
    providerId: z.string(),
    externalId: z.string(),
    memberActivityId: z.string().optional(),
    subsource: z.string().nullable().optional(),
  })
  .strict();

const equivalenceKeySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("provider_workout_id"),
      provider: z.literal("peloton"),
      value: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cycling_route"),
      provider: z.string(),
      activity_name: z.string(),
      provider_type: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("standardized_test"),
      provider: z.string(),
      activity_name: z.string(),
      provider_type: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("climb"),
      climb_type: z.string(),
      grade_system: z.string(),
      grade: z.string(),
      route_name: z.string(),
      location_name: z.string(),
      lead: z.boolean().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("strength_exercise_id"), exercise_id: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("activity_name"),
      canonical_type: z.string(),
      value: z.string(),
    })
    .strict(),
]);

const cyclingSchema = z
  .object({
    average_power_watts: nullableNumber,
    normalized_power_watts: nullableNumber,
    average_heart_rate_bpm: nullableNumber,
    max_heart_rate_bpm: nullableNumber,
    average_cadence_rpm: nullableNumber,
    power_to_heart_rate_ratio: nullableNumber,
    distance_meters: nullableNumber,
    elevation_gain_meters: nullableNumber,
    sample_coverage: z
      .object({
        total_samples: z.number().int().nonnegative().nullable(),
        power_samples: z.number().int().nonnegative().nullable(),
        heart_rate_samples: z.number().int().nonnegative().nullable(),
        status: z.enum(["available", "not_available"]),
      })
      .strict(),
  })
  .strict();

const climbingSchema = z
  .object({
    source_entries: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    excluded_ambiguous_entries: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative().nullable(),
    attempts_status: z.enum(["complete", "partial", "unavailable"]),
    sends: z.number().int().nonnegative().nullable(),
    outcomes_status: z.enum(["complete", "partial", "unavailable"]),
    observed_grades: z.array(z.string()),
    evidence: z
      .array(
        z
          .object({
            climb_type: z.string(),
            grade_system: z.string(),
            grade: z.string(),
            route_name: z.string().nullable(),
            location_name: z.string().nullable(),
            sent: z.boolean().nullable(),
            attempt_count: z.number().int().positive().nullable(),
            lead: z.boolean().nullable(),
            status: z.enum(["included", "excluded_ambiguous"]),
            source_entry_ids: z.array(z.uuid()).max(20),
            source_activity_ids: z.array(z.uuid()).max(20),
            source_providers: z.array(z.string()).max(20),
            source_entry_count: z.number().int().nonnegative(),
            source_activity_count: z.number().int().nonnegative(),
            source_provider_count: z.number().int().nonnegative(),
            source_evidence_truncated: z.boolean(),
            merged_duplicate: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    evidence_count: z.number().int().nonnegative(),
    evidence_truncated: z.boolean(),
  })
  .strict();

const strengthSchema = z
  .object({
    source_sets: z.number().int().nonnegative(),
    sets: z.number().int().nonnegative(),
    working_sets: z.number().int().nonnegative(),
    valid_volume_sets: z.number().int().nonnegative(),
    missing_volume_sets: z.number().int().nonnegative(),
    valid_volume_kg_reps: nullableNumber,
    volume_status: z.enum(["complete", "partial", "unavailable"]),
    best_estimated_one_rep_max_kg: nullableNumber,
    estimated_one_rep_max_status: z.enum(["complete", "partial", "unavailable"]),
    suspicious_sets: z.number().int().nonnegative(),
    excluded_sets: z.number().int().nonnegative(),
  })
  .strict();

const deltaSchema = z
  .object({
    duration_seconds: nullableNumber,
    moving_duration_seconds: nullableNumber,
    average_power_watts: nullableNumber,
    normalized_power_watts: nullableNumber,
    average_heart_rate_bpm: nullableNumber,
    average_cadence_rpm: nullableNumber,
    power_to_heart_rate_ratio: nullableNumber,
    distance_meters: nullableNumber,
    elevation_gain_meters: nullableNumber,
    average_temperature_c: nullableNumber,
    climbing_attempts: nullableNumber,
    climbing_sends: nullableNumber,
    strength_volume_kg_reps: nullableNumber,
    strength_estimated_one_rep_max_kg: nullableNumber,
  })
  .strict();

const movingDurationSchema = z
  .object({
    seconds: z.number().int().nonnegative().nullable(),
    status: z.enum(["available", "conflicting", "not_available"]),
    evidence: z
      .array(
        z
          .object({
            provider: z.string(),
            source_activity_id: z.uuid(),
            raw_field: z.string(),
            seconds: z.number().int().nonnegative(),
            value_kind: z.literal("provider_reported"),
          })
          .strict(),
      )
      .max(20),
    evidence_count: z.number().int().nonnegative(),
    evidence_truncated: z.boolean(),
  })
  .strict();

const equivalenceEvidenceSchema = z
  .object({
    evidence_type: z.enum([
      "provider_raw_field",
      "cycling_route_name_provider_type",
      "standardized_test_name_provider_type",
      "climbing_entry",
      "strength_set",
      "canonical_activity_name",
    ]),
    provider: z.string().nullable(),
    value: z.string(),
    field: z.string().nullable(),
    provider_type: z.string().nullable(),
    source_activity_id: z.uuid(),
    source_record_id: z.uuid().nullable(),
  })
  .strict();

/** Strict MCP wire contract for equivalence-constrained longitudinal performance comparisons. */
export const performanceComparisonOutputSchema = z
  .object({
    result: z
      .object({
        range: z
          .object({ start_date: z.string(), end_date: z.string(), timezone: z.string() })
          .strict(),
        equivalence: z
          .object({
            basis: z.enum(["derived_from_reference", "explicit"]),
            method: z.string(),
            confidence: z.enum(["high", "user_asserted"]),
            key: equivalenceKeySchema,
            assumptions: z.array(z.string()),
          })
          .strict(),
        baseline: z
          .object({
            activity_id: z.uuid(),
            selection: z.enum(["requested_reference", "earliest_match_in_range"]),
          })
          .strict(),
        definitions: z
          .object({
            comparison: z.string(),
            moving_duration: z.string(),
            normalized_power: z.string(),
            power_to_heart_rate_ratio: z.string(),
            deltas: z.string(),
            strength_estimated_one_rep_max: z.string(),
            causality: z.string(),
          })
          .strict(),
        coverage: z
          .object({
            canonical_activities: z.number().int().nonnegative(),
            cycling_metrics_from_deduped_samples: z.number().int().nonnegative(),
            environment_metrics_from_deduped_samples: z.number().int().nonnegative(),
            activities_with_missing_duration: z.number().int().nonnegative(),
            timezone_assumed_activities: z.number().int().nonnegative(),
            performances_with_equivalence_evidence: z.number().int().nonnegative(),
            performances_with_moving_duration: z.number().int().nonnegative(),
          })
          .strict(),
        performances: z.array(
          z
            .object({
              activity_id: z.uuid(),
              date: z.string(),
              started_at: z.string(),
              name: z.string().nullable(),
              canonical_type: z.string(),
              modality: z.string().nullable(),
              duration_seconds: nullableNumber,
              moving_duration: movingDurationSchema,
              route: z
                .object({
                  status: z.enum(["caller_asserted", "not_available"]),
                  provider: z.string().nullable(),
                  activity_name: z.string().nullable(),
                  provider_type: z.string().nullable(),
                  evidence: z.enum([
                    "caller_asserted_activity_name_provider_type",
                    "comparison_not_keyed_by_route",
                  ]),
                })
                .strict(),
              equivalence_evidence: z.array(equivalenceEvidenceSchema).max(100),
              equivalence_evidence_count: z.number().int().nonnegative(),
              equivalence_evidence_truncated: z.boolean(),
              is_baseline: z.boolean(),
              source_providers: z.array(z.string()).max(100),
              source_provider_count: z.number().int().nonnegative(),
              source_external_ids: z.array(sourceExternalIdSchema).max(100),
              source_external_id_count: z.number().int().nonnegative(),
              member_activity_ids: z.array(z.uuid()).max(100),
              member_activity_id_count: z.number().int().nonnegative(),
              activity_source_evidence_truncated: z.boolean(),
              timezone: z
                .object({
                  value: z.string().nullable(),
                  start_utc_offset_minutes: z.number().int().nullable(),
                  local_time_source: z.string(),
                  analysis_timezone: z.string(),
                  assumed: z.boolean(),
                })
                .strict(),
              metrics: z
                .object({
                  cycling: cyclingSchema.nullable(),
                  climbing: climbingSchema.nullable(),
                  strength: strengthSchema.nullable(),
                  environment: z
                    .object({
                      average_temperature_c: nullableNumber,
                      status: z.enum(["available", "not_available"]),
                      value_kind: z.literal("calculated_from_deduped_samples"),
                    })
                    .strict(),
                })
                .strict(),
              delta_to_baseline: deltaSchema,
              quality: z
                .object({ comparable: z.literal(true), flags: z.array(z.string()) })
                .strict(),
              provenance: z
                .object({
                  value_kind: z.literal("mixed"),
                  activity_deduplication: z.literal("fitness.v_activity"),
                  sensor_deduplication: z.literal(
                    "analytics.activity_summary_rows/activity_sensor_sample FINAL",
                  ),
                  sample_source_providers: z.array(z.string()).max(100),
                  sample_source_provider_count: z.number().int().nonnegative(),
                  sample_device_ids: z.array(z.string()).max(100),
                  sample_device_id_count: z.number().int().nonnegative(),
                  sample_source_evidence_truncated: z.boolean(),
                })
                .strict(),
            })
            .strict(),
        ),
        rejected_near_matches: z
          .object({
            status: z.literal("not_evaluated"),
            reason: z.string(),
            items: z.array(z.never()).max(0),
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
