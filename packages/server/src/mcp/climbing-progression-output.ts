import { FREE_ROCK_GRADE_SYSTEMS } from "@dofek/training/climbing-grades";
import {
  attemptScopeSchema,
  climbingAttemptSchema,
  ropeMethodSchema,
} from "@dofek/training/climbing-log";
import { z } from "zod";

const nullableNumber = z.number().nullable();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestampSchema = z.string().datetime({ offset: true });
const laneShape = {
  climb_kind: z.enum(["boulder", "route"]),
  attempt_scope: attemptScopeSchema,
  rope_method: ropeMethodSchema.nullable(),
  solo: z.boolean().nullable(),
  used_aid: z.boolean().nullable(),
};
const rockResultLabelsSchema = z.object({
  onsight: z.boolean().nullable(),
  flash: z.boolean().nullable(),
});
const gradeSystemSchema = z.enum(FREE_ROCK_GRADE_SYSTEMS);
const attemptCoverageSchema = z.enum(["complete", "partial", "unavailable"]);
const sourceExternalIdSchema = z
  .object({
    providerId: z.string(),
    externalId: z.string(),
    memberActivityId: z.string().optional(),
    subsource: z.string().nullable().optional(),
  })
  .strict();
const hardestSchema = z
  .object({
    grade: z.string(),
    grade_system: gradeSystemSchema,
    normalized_grade: z.string().nullable(),
    normalized_grade_system: gradeSystemSchema,
    ...laneShape,
    date: dateSchema,
    activity_id: z.uuid(),
    entry_id: z.uuid(),
    rock_result_labels: rockResultLabelsSchema.nullable(),
    source_providers: z.array(z.string()),
  })
  .strict();

/** Strict MCP wire contract for longitudinal climbing progression. */
export const climbingProgressionOutputSchema = z
  .object({
    result: z
      .object({
        range: z
          .object({ start_date: dateSchema, end_date: dateSchema, timezone: z.string() })
          .strict(),
        definitions: z
          .object({
            attempts: z.string().min(1),
            send_rate: z.string().min(1),
            rolling_exposure: z.string().min(1),
            duplicate_handling: z.string().min(1),
            volume_below_range_hardest_send: z.string().min(1),
          })
          .strict(),
        coverage: z
          .object({
            sessions: z.number().int().nonnegative(),
            entries: z.number().int().nonnegative(),
            entries_with_attempts: z.number().int().nonnegative(),
            observed_free_send_outcomes: z.number().int().nonnegative(),
            attempt_data: attemptCoverageSchema,
            unknown_free_send_outcomes: z.number().int().nonnegative(),
            first_observed_date: dateSchema.nullable(),
            timezone_assumed_sessions: z.number().int().nonnegative(),
            merged_exact_duplicate_records: z.number().int().nonnegative(),
            possible_duplicate_groups: z.number().int().nonnegative(),
            entries_excluded_from_aggregates: z.number().int().nonnegative(),
          })
          .strict(),
        daily: z.array(
          z
            .object({
              date: dateSchema,
              exposure_status: z.enum(["observed", "not_observed", "unavailable"]),
              sessions: z.number().int().nonnegative().nullable(),
              entries: z.number().int().nonnegative().nullable(),
              attempts: z.number().int().nonnegative().nullable(),
              attempts_status: attemptCoverageSchema,
              sends: z.number().int().nonnegative().nullable(),
              failed_attempts: z.number().int().nonnegative().nullable(),
              observed_outcomes: z.number().int().nonnegative().nullable(),
              unknown_outcomes: z.number().int().nonnegative().nullable(),
              send_rate: nullableNumber,
              is_rest_day: z.boolean().nullable(),
              consecutive_climbing_days: z.number().int().nonnegative().nullable(),
              rolling_7d_exposure_days: z.number().int().min(0).max(7).nullable(),
              rolling_28d_exposure_days: z.number().int().min(0).max(28).nullable(),
            })
            .strict(),
        ),
        grade_distribution: z.array(
          z
            .object({
              ...laneShape,
              grade: z.string(),
              grade_system: gradeSystemSchema,
              normalized_grade: z.string().nullable(),
              normalized_grade_system: gradeSystemSchema,
              grade_sort_value: nullableNumber,
              entries: z.number().int().nonnegative(),
              attempts: z.number().int().nonnegative().nullable(),
              attempts_status: attemptCoverageSchema,
              entries_with_attempts: z.number().int().nonnegative(),
              sends: z.number().int().nonnegative().nullable(),
              failed_attempts: z.number().int().nonnegative().nullable(),
              observed_outcomes: z.number().int().nonnegative(),
              unknown_outcomes: z.number().int().nonnegative(),
              send_rate: nullableNumber,
              attempts_per_send: nullableNumber,
            })
            .strict(),
        ),
        grade_progression: z.array(
          z
            .object({
              date: dateSchema,
              ...laneShape,
              grade: z.string(),
              grade_system: gradeSystemSchema,
              normalized_grade: z.string().nullable(),
              normalized_grade_system: gradeSystemSchema,
              grade_sort_value: nullableNumber,
              activity_id: z.uuid(),
              entry_id: z.uuid(),
              source_providers: z.array(z.string()),
            })
            .strict(),
        ),
        hardest: z
          .object({
            send: hardestSchema.nullable(),
            flash: hardestSchema.nullable(),
            onsight: hardestSchema.nullable(),
          })
          .strict(),
        below_range_hardest_send: z
          .object({
            metric_name: z.literal("volume_below_range_hardest_send"),
            entries: z.number().int().nonnegative(),
            attempts: z.number().int().nonnegative().nullable(),
            status: attemptCoverageSchema,
          })
          .strict(),
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
              climbing_log_entries: z.array(
                z
                  .object({
                    id: z.uuid(),
                    ...laneShape,
                    pitch_id: z.uuid().nullable(),
                    pitch_number: z.number().int().positive().nullable(),
                    grade: z.string().nullable(),
                    grade_system: gradeSystemSchema.nullable(),
                    normalized_grade: z.string().nullable(),
                    normalized_grade_system: gradeSystemSchema,
                    sends: z.number().int().nonnegative(),
                    unknown_outcomes: z.number().int().nonnegative(),
                    recorded_attempt_count: z.number().int().positive(),
                    attempts: z.array(climbingAttemptSchema),
                    rock_result_labels: rockResultLabelsSchema.nullable(),
                    wall_angle_degrees: nullableNumber,
                    hold_type: z.string().nullable(),
                    climb_name: z.string().nullable(),
                    location_name: z.string().nullable(),
                    external_id: z.string().nullable(),
                    provenance: z
                      .object({
                        value_kind: z.literal("measured"),
                        source_entry_ids: z.array(z.uuid()),
                        source_activity_ids: z.array(z.uuid()),
                        source_providers: z.array(z.string()),
                        source_names: z.array(z.string()),
                        source_external_entry_ids: z.array(
                          z.object({ provider: z.string(), external_id: z.string() }).strict(),
                        ),
                        merged_duplicate: z.boolean(),
                      })
                      .strict(),
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
